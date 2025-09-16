# FFmpeg Video Merger API

A robust video merging API that processes multiple video URLs, merges them using FFmpeg, and uploads the result to Cloudinary CDN. Perfect for n8n automation workflows.

## 🚀 Features

- **Video Merging**: Concatenate multiple videos using FFmpeg
- **Cloudinary Integration**: Automatic upload to Cloudinary CDN
- **Domain Security**: Use custom domain instead of IP addresses
- **Process Management**: PM2 for production reliability
- **Error Handling**: Comprehensive error management
- **Health Monitoring**: Built-in health check endpoints

## 📋 Prerequisites

- Ubuntu 20.04+ (DigitalOcean Droplet)
- Node.js 16+ and npm
- FFmpeg
- PM2 process manager
- Cloudinary account
- DuckDNS account (optional)

## 🛠️ Server Setup

### 1. Create DigitalOcean Droplet

```bash
# Recommended specs:
# - $4/month Basic Droplet (512MB RAM, 1 CPU, 10GB SSD)
# - Ubuntu 20.04 LTS
# - Enable IPv6 and monitoring
```

### 2. Initial Server Configuration

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install FFmpeg
sudo apt install ffmpeg -y

# Install PM2 globally
sudo npm install -g pm2

# Create app directory
sudo mkdir -p /opt/ffmpeg-video-merger
sudo chown $USER:$USER /opt/ffmpeg-video-merger
cd /opt/ffmpeg-video-merger

# Clone repository
git clone https://github.com/YOUR_USERNAME/ffmpeg-video-merger.git .
```

### 3. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit environment variables
nano .env
```

**Required Environment Variables:**
```env
PORT=3000
DOMAIN=videomerger.duckdns.org
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
NODE_ENV=production
```

### 4. Install Dependencies and Start

```bash
# Install dependencies
npm install

# Create logs directory
mkdir -p logs

# Start with PM2
npm run pm2:start

# Enable PM2 startup
pm2 startup
pm2 save
```

### 5. Configure Firewall

```bash
# Enable UFW
sudo ufw enable

# Allow SSH, HTTP, and custom port
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 3000

# Check status
sudo ufw status
```

## 🌐 Domain Setup (DuckDNS)

### 1. Register DuckDNS Domain

1. Go to [DuckDNS.org](https://www.duckdns.org)
2. Sign in with your preferred method
3. Create subdomain: `videomerger`
4. Note your token

### 2. Configure DuckDNS

```bash
# Create update script
echo "echo url=\"https://www.duckdns.org/update?domains=videomerger&token=YOUR_TOKEN&ip=\" | curl -k -o ~/duckdns.log -K -" > ~/duckdns.sh
chmod +x ~/duckdns.sh

# Test the script
./duckdns.sh

# Add to crontab for auto-update
crontab -e
# Add this line:
*/5 * * * * ~/duckdns.sh >/dev/null 2>&1
```

## ☁️ Cloudinary Setup

### 1. Create Cloudinary Account

1. Go to [Cloudinary.com](https://cloudinary.com)
2. Sign up for free account
3. Go to Dashboard
4. Copy your credentials

### 2. Configure Cloudinary

Add these to your `.env` file:
```env
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=your_secret_key
```

## 🔧 API Usage

### Health Check
```bash
GET http://videomerger.duckdns.org:3000/health
```

### Merge Videos
```bash
POST http://videomerger.duckdns.org:3000/merge-videos
Content-Type: application/json

{
  "videoUrls": [
    "https://example.com/video1.mp4",
    "https://example.com/video2.mp4"
  ]
}
```

### Response
```json
{
  "success": true,
  "message": "Videos merged successfully",
  "videoUrl": "https://res.cloudinary.com/your-cloud/video/upload/merged-videos/merged_123456.mp4",
  "publicId": "merged_123456",
  "videosProcessed": 2,
  "timestamp": "2025-09-16T12:00:00.000Z"
}
```

## 🔗 n8n Integration

### HTTP Request Node Configuration

- **Method**: POST
- **URL**: `http://videomerger.duckdns.org:3000/merge-videos`
- **Headers**: 
  ```json
  {
    "Content-Type": "application/json"
  }
  ```
- **Body**:
  ```json
  {
    "videoUrls": [
      "{{ $json.video1_url }}",
      "{{ $json.video2_url }}"
    ]
  }
  ```

### Expected Output

The response will contain `videoUrl` with the Cloudinary CDN link that you can use in subsequent n8n nodes.

## 📊 Monitoring

### PM2 Commands
```bash
# View status
pm2 status

# View logs
pm2 logs ffmpeg-video-merger

# Restart app
pm2 restart ffmpeg-video-merger

# Stop app
pm2 stop ffmpeg-video-merger

# Monitor in real-time
pm2 monit
```

### Log Files
- **Application logs**: `~/logs/`
- **PM2 logs**: `~/.pm2/logs/`
- **System logs**: `/var/log/`

## 🛡️ Security Considerations

1. **Firewall**: Only open necessary ports
2. **Domain**: Use DuckDNS instead of IP addresses
3. **Environment**: Keep `.env` file secure
4. **Updates**: Regularly update system and dependencies
5. **Monitoring**: Monitor logs for unusual activity

## 🔄 Updates and Maintenance

### Update Application
```bash
cd /opt/ffmpeg-video-merger
git pull origin main
npm install
pm2 restart ffmpeg-video-merger
```

### System Maintenance
```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Clean up old logs
pm2 flush

# Check disk space
df -h
```

## ❌ Troubleshooting

### Common Issues

1. **FFmpeg not found**
   ```bash
   sudo apt install ffmpeg -y
   ```

2. **PM2 not starting**
   ```bash
   pm2 delete all
   pm2 start ecosystem.config.js
   ```

3. **Cloudinary upload failed**
   - Check credentials in `.env`
   - Verify internet connectivity
   - Check Cloudinary quota

4. **Video download failed**
   - Verify video URLs are accessible
   - Check network connectivity
   - Review video format compatibility

### Debug Mode
```bash
# Run in development mode
npm run dev

# Check detailed logs
pm2 logs ffmpeg-video-merger --lines 100
```

## 📝 License

MIT License - feel free to modify and distribute.

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Commit changes
4. Push to branch
5. Create Pull Request

---

**Need help?** Check the logs first, then create an issue with detailed error information.
