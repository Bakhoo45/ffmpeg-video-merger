#!/bin/bash

# FFmpeg Video Merger - Quick Setup Script
# Run this script on your DigitalOcean droplet after cloning the repository

echo "🚀 Setting up FFmpeg Video Merger..."

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 18.x
echo "📊 Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install FFmpeg
echo "🎬 Installing FFmpeg..."
sudo apt install ffmpeg -y

# Install PM2 globally
echo "⚙️ Installing PM2..."
sudo npm install -g pm2

# Install project dependencies
echo "📚 Installing project dependencies..."
npm install

# Create necessary directories
echo "📁 Creating directories..."
mkdir -p logs
mkdir -p temp

# Set up environment file
echo "🔧 Setting up environment..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "⚠️ IMPORTANT: Edit .env file with your Cloudinary credentials!"
    echo "   nano .env"
else
    echo "✅ .env file already exists"
fi

# Configure firewall
echo "🔒 Configuring firewall..."
sudo ufw --force enable
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 3000

echo ""
echo "🎉 Setup completed!"
echo ""
echo "Next steps:"
echo "1. Edit .env file with your Cloudinary credentials:"
echo "   nano .env"
echo ""
echo "2. Start the application:"
echo "   npm run pm2:start"
echo ""
echo "3. Enable PM2 startup:"
echo "   pm2 startup"
echo "   pm2 save"
echo ""
echo "4. Test the API:"
echo "   curl http://localhost:3000/health"
echo ""
echo "🌐 Don't forget to set up DuckDNS if you want a custom domain!"
