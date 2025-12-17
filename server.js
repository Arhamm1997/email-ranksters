const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize SQLite database
const dbPath = path.join(__dirname, 'tracking.db');
const db = new sqlite3.Database(dbPath);

// Create table if not exists
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS email_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_id TEXT UNIQUE NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      first_opened DATETIME,
      last_opened DATETIME,
      open_count INTEGER DEFAULT 0,
      sender_ip TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Create 1x1 transparent pixel
const transparentPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// Helper function to check if IP is likely Gmail proxy
function isGmailProxy(userAgent, ip) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return ua.includes('google') || ua.includes('gmail') || ua.includes('googleimageproxy');
}

// Helper function to check if it's too soon after creation (likely sender viewing)
function isTooSoonAfterCreation(createdAt) {
  if (!createdAt) return false;
  const timeDiff = Date.now() - new Date(createdAt).getTime();
  // If opened within 2 minutes of creation, likely sender viewing in Sent folder
  return timeDiff < 120000; // 2 minutes
}

// Tracking pixel endpoint
app.get('/track/:trackingId.png', (req, res) => {
  const { trackingId } = req.params;
  const ipAddress = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const timestamp = new Date().toISOString();
  
  console.log(`📧 Tracking pixel loaded! ID: ${trackingId}`);
  console.log(`   IP: ${ipAddress}`);
  console.log(`   User Agent: ${userAgent}`);
  console.log(`   Time: ${timestamp}`);
  
  // Check if tracking ID exists
  db.get('SELECT * FROM email_tracking WHERE tracking_id = ?', [trackingId], (err, row) => {
    if (err) {
      console.error('Database error:', err);
    } else if (row) {
      // Email already tracked - this is a subsequent open
      const isSenderIP = row.sender_ip && ipAddress === row.sender_ip;
      const isGmailProxyOpen = isGmailProxy(userAgent, ipAddress);
      const isTooSoon = isTooSoonAfterCreation(row.created_at);
      
      console.log(`   📊 Existing record found`);
      console.log(`   🔍 Same IP as sender: ${isSenderIP}`);
      console.log(`   🔍 Gmail proxy: ${isGmailProxyOpen}`);
      console.log(`   🔍 Too soon: ${isTooSoon}`);
      
      // Only count as real open if:
      // 1. Not from sender's IP OR
      // 2. More than 2 minutes have passed since creation
      if (!isSenderIP || !isTooSoon) {
        db.run(
          'UPDATE email_tracking SET last_opened = ?, open_count = open_count + 1, ip_address = ?, user_agent = ? WHERE tracking_id = ?',
          [timestamp, ipAddress, userAgent, trackingId]
        );
        console.log(`   ✅ Counted as REAL open (count: ${row.open_count + 1})`);
      } else {
        console.log(`   ⚠️ IGNORED - Sender viewing own email`);
      }
    } else {
      // First time seeing this tracking ID - record sender's IP
      console.log(`   🆕 New tracking ID - Recording sender IP`);
      db.run(
        'INSERT INTO email_tracking (tracking_id, ip_address, user_agent, first_opened, last_opened, open_count, sender_ip) VALUES (?, ?, ?, ?, ?, 0, ?)',
        [trackingId, ipAddress, userAgent, timestamp, timestamp, ipAddress],
        (insertErr) => {
          if (insertErr) {
            console.error('Insert error:', insertErr);
          } else {
            console.log(`   ✅ Sender IP recorded: ${ipAddress}`);
          }
        }
      );
    }
  });
  
  // Always return transparent pixel
  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.send(transparentPixel);
});

// API to get recent opens (for extension to poll)
app.get('/api/recent-opens', (req, res) => {
  const since = req.query.since || new Date(Date.now() - 3600000).toISOString(); // Last hour by default
  
  db.all(
    `SELECT tracking_id, ip_address, first_opened, last_opened, open_count, sender_ip, created_at 
     FROM email_tracking 
     WHERE first_opened > ? AND open_count > 0
     ORDER BY first_opened DESC`,
    [since],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: 'Database error' });
      } else {
        // Filter out opens that are too soon (likely sender viewing)
        const realOpens = rows.filter(row => {
          const timeDiff = Date.now() - new Date(row.created_at).getTime();
          // Only include if more than 2 minutes have passed since creation
          return timeDiff >= 120000 || row.open_count > 1;
        });
        
        res.json(realOpens.map(row => ({
          trackingId: row.tracking_id,
          ipAddress: row.ip_address,
          timestamp: new Date(row.first_opened).getTime(),
          lastOpened: new Date(row.last_opened).getTime(),
          openCount: row.open_count
        })));
      }
    }
  );
});

// API to get stats for a specific tracking ID
app.get('/api/tracking/:trackingId', (req, res) => {
  const { trackingId } = req.params;
  
  db.get('SELECT * FROM email_tracking WHERE tracking_id = ?', [trackingId], (err, row) => {
    if (err) {
      res.status(500).json({ error: 'Database error' });
    } else if (row) {
      res.json({
        trackingId: row.tracking_id,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        firstOpened: row.first_opened,
        lastOpened: row.last_opened,
        openCount: row.open_count,
        senderIp: row.sender_ip
      });
    } else {
      res.status(404).json({ error: 'Tracking ID not found' });
    }
  });
});

// API to get all tracking data
app.get('/api/all-tracking', (req, res) => {
  db.all(
    'SELECT tracking_id, ip_address, first_opened, last_opened, open_count, sender_ip FROM email_tracking WHERE open_count > 0 ORDER BY first_opened DESC LIMIT 100',
    [],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: 'Database error' });
      } else {
        res.json(rows);
      }
    }
  );
});

// Root endpoint - Welcome page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Email Tracker Server</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          max-width: 600px;
          margin: 50px auto;
          padding: 20px;
          background: #f5f5f5;
        }
        .container {
          background: white;
          padding: 30px;
          border-radius: 10px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
          color: #4285f4;
          margin-bottom: 10px;
        }
        .status {
          display: inline-block;
          padding: 5px 15px;
          background: #34a853;
          color: white;
          border-radius: 20px;
          font-size: 14px;
          margin: 10px 0;
        }
        .endpoint {
          background: #f8f9fa;
          padding: 15px;
          margin: 10px 0;
          border-radius: 5px;
          border-left: 3px solid #4285f4;
        }
        .endpoint code {
          color: #e91e63;
          font-family: 'Courier New', monospace;
        }
        .info {
          color: #666;
          font-size: 14px;
          margin-top: 20px;
          padding-top: 20px;
          border-top: 1px solid #eee;
        }
        .copy-url {
          background: #4285f4;
          color: white;
          padding: 10px 20px;
          border-radius: 5px;
          text-decoration: none;
          display: inline-block;
          margin: 10px 0;
        }
        .copy-url:hover {
          background: #3367d6;
        }
        .new-feature {
          background: #fff3cd;
          padding: 15px;
          border-radius: 5px;
          margin: 15px 0;
          border-left: 3px solid #ffc107;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📧 Email Tracker Server</h1>
        <div class="status">✓ Server Running</div>
        
        <div class="new-feature">
          <strong>🆕 New Feature:</strong> Smart sender detection! The server now ignores when you view your own sent emails, preventing false "Email Opened" notifications.
        </div>
        
        <h3>Server Information:</h3>
        <p><strong>Status:</strong> Active and ready to track emails</p>
        <p><strong>URL:</strong> <code>${req.protocol}://${req.get('host')}</code></p>
        <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
        <p><strong>Version:</strong> 2.0 (IP Filtering Enabled)</p>
        
        <h3>Available Endpoints:</h3>
        
        <div class="endpoint">
          <strong>Tracking Pixel:</strong><br>
          <code>GET /track/{tracking_id}.png</code><br>
          <small>Returns transparent 1x1 pixel for email tracking</small>
        </div>
        
        <div class="endpoint">
          <strong>Recent Opens:</strong><br>
          <code>GET /api/recent-opens</code><br>
          <small>Returns list of recently opened emails (filters out sender views)</small>
        </div>
        
        <div class="endpoint">
          <strong>Specific Tracking:</strong><br>
          <code>GET /api/tracking/{tracking_id}</code><br>
          <small>Returns details for a specific tracking ID</small>
        </div>
        
        <div class="endpoint">
          <strong>All Tracking Data:</strong><br>
          <code>GET /api/all-tracking</code><br>
          <small>Returns all tracking records</small>
        </div>
        
        <div class="endpoint">
          <strong>Health Check:</strong><br>
          <code>GET /health</code><br>
          <small>Server health status in JSON format</small>
        </div>
        
        <h3>Next Steps:</h3>
        <ol>
          <li>Copy this server URL</li>
          <li>Open Chrome Extension popup</li>
          <li>Paste URL in "Server URL" field</li>
          <li>Click "Save Settings"</li>
          <li>Start tracking emails! ✓✓</li>
        </ol>
        
        <a href="${req.protocol}://${req.get('host')}" class="copy-url" onclick="navigator.clipboard.writeText('${req.protocol}://${req.get('host')}'); alert('URL copied to clipboard!'); return false;">
          📋 Copy Server URL
        </a>
        
        <div class="info">
          <strong>🔒 Security Note:</strong> This server is for email tracking only. 
          No sensitive data is displayed publicly.<br><br>
          <strong>📊 Usage:</strong> Use this URL in your Chrome Extension settings to enable tracking.<br><br>
          <strong>🎯 Smart Detection:</strong> The server now tracks sender IP and ignores opens within 2 minutes of sending to prevent false positives.
        </div>
      </div>
    </body>
    </html>
  `);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Email tracking server is running',
    version: '2.0-ip-filtering',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log('🚀 Email Tracker Backend Server Started!');
  console.log(`📍 Server running on http://localhost:${PORT}`);
  console.log(`📧 Tracking endpoint: http://localhost:${PORT}/track/{tracking_id}.png`);
  console.log(`📊 API endpoint: http://localhost:${PORT}/api/recent-opens`);
  console.log('🎯 Smart sender detection: ENABLED');
  console.log('\n✅ Ready to track emails!\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down server...');
  db.close();
  process.exit(0);
});
