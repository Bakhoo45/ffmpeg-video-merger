const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Temporary directory for video processing
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Helper function to download video from URL
async function downloadVideo(url, filename) {
  try {
    console.log(`Downloading video from: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const buffer = await response.buffer();
    const filepath = path.join(TEMP_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    
    console.log(`Video downloaded successfully: ${filename}`);
    return filepath;
  } catch (error) {
    console.error(`Error downloading video: ${error.message}`);
    throw error;
  }
}

// Helper function to merge videos using FFmpeg
function mergeVideos(inputFiles, outputFile) {
  return new Promise((resolve, reject) => {
    console.log(`Merging ${inputFiles.length} videos...`);
    
    // Create input list file for FFmpeg
    const listFile = path.join(TEMP_DIR, `input_list_${uuidv4()}.txt`);
    const listContent = inputFiles.map(file => `file '${file}'`).join('\n');
    fs.writeFileSync(listFile, listContent);
    
    // FFmpeg command to concatenate videos
    const ffmpegArgs = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-y', // Overwrite output file
      outputFile
    ];
    
    console.log(`Running FFmpeg with args: ${ffmpegArgs.join(' ')}`);
    
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    
    ffmpeg.stdout.on('data', (data) => {
      console.log(`FFmpeg stdout: ${data}`);
    });
    
    ffmpeg.stderr.on('data', (data) => {
      console.log(`FFmpeg stderr: ${data}`);
    });
    
    ffmpeg.on('close', (code) => {
      // Clean up list file
      fs.unlinkSync(listFile);
      
      if (code === 0) {
        console.log('Video merging completed successfully');
        resolve();
      } else {
        console.error(`FFmpeg process exited with code ${code}`);
        reject(new Error(`FFmpeg failed with exit code ${code}`));
      }
    });
    
    ffmpeg.on('error', (error) => {
      console.error(`FFmpeg error: ${error.message}`);
      reject(error);
    });
  });
}

// Helper function to upload video to Cloudinary
async function uploadToCloudinary(filePath, publicId) {
  try {
    console.log(`Uploading to Cloudinary: ${filePath}`);
    
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: 'video',
      public_id: publicId,
      folder: 'merged-videos',
      quality: 'auto',
      format: 'mp4'
    });
    
    console.log(`Upload successful. URL: ${result.secure_url}`);
    return result.secure_url;
  } catch (error) {
    console.error(`Cloudinary upload error: ${error.message}`);
    throw error;
  }
}

// Helper function to clean up temporary files
function cleanupFiles(files) {
  files.forEach(file => {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log(`Cleaned up: ${file}`);
      }
    } catch (error) {
      console.error(`Error cleaning up file ${file}: ${error.message}`);
    }
  });
}

// Routes

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'FFmpeg Video Merger',
    version: '2.0.0',
    time: new Date().toISOString(),
    cloudinary: process.env.CLOUDINARY_CLOUD_NAME ? 'configured' : 'not configured'
  });
});

// API info endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'FFmpeg Video Merger API',
    version: '2.0.0',
    description: 'Merge videos and upload to Cloudinary',
    endpoints: {
      health: 'GET /health',
      merge: 'POST /merge-videos'
    },
    usage: {
      endpoint: '/merge-videos',
      method: 'POST',
      body: {
        videoUrls: ['array of video URLs to merge']
      }
    },
    storage: 'Cloudinary CDN',
    domain: process.env.DOMAIN || 'videomerger.duckdns.org'
  });
});

// Main video merge endpoint
app.post('/merge-videos', async (req, res) => {
  console.log('\n--- New merge request ---');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  
  const { videoUrls } = req.body;
  
  // Validation
  if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'videoUrls array is required and must contain at least one URL'
    });
  }
  
  if (videoUrls.length > 10) {
    return res.status(400).json({
      success: false,
      error: 'Maximum 10 videos allowed per merge request'
    });
  }
  
  // Check Cloudinary configuration
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return res.status(500).json({
      success: false,
      error: 'Cloudinary configuration missing'
    });
  }
  
  const sessionId = uuidv4();
  const downloadedFiles = [];
  
  try {
    // Download all videos
    console.log(`Downloading ${videoUrls.length} videos...`);
    for (let i = 0; i < videoUrls.length; i++) {
      const filename = `${sessionId}_video_${i + 1}.mp4`;
      const filePath = await downloadVideo(videoUrls[i], filename);
      downloadedFiles.push(filePath);
    }
    
    // Merge videos
    const outputFilename = `merged_${sessionId}.mp4`;
    const outputPath = path.join(TEMP_DIR, outputFilename);
    
    await mergeVideos(downloadedFiles, outputPath);
    
    // Upload to Cloudinary
    const publicId = `merged_${Date.now()}_${sessionId}`;
    const cloudinaryUrl = await uploadToCloudinary(outputPath, publicId);
    
    // Clean up temporary files
    cleanupFiles([...downloadedFiles, outputPath]);
    
    // Success response
    const response = {
      success: true,
      message: 'Videos merged successfully',
      videoUrl: cloudinaryUrl,
      publicId: publicId,
      videosProcessed: videoUrls.length,
      timestamp: new Date().toISOString()
    };
    
    console.log('Merge completed successfully:', response);
    res.json(response);
    
  } catch (error) {
    console.error('Error during video merge process:', error);
    
    // Clean up any downloaded files in case of error
    cleanupFiles([...downloadedFiles]);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Video merge failed',
      message: 'Failed to merge videos'
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    message: 'The requested endpoint does not exist'
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FFmpeg Video Merger API running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 API info: http://localhost:${PORT}/`);
  console.log(`☁️  Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? 'Configured' : 'Not configured'}`);
  console.log(`🌍 Domain: ${process.env.DOMAIN || 'Not set'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
