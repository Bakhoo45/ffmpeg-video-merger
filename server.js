const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const cron = require('node-cron');
const ffmpeg = require('fluent-ffmpeg');
const AWS = require('aws-sdk');
const streamBuffers = require('stream-buffers');
const progressStream = require('progress-stream');
const FormData = require('form-data');
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

// Auto-cleanup: Remove videos older than 30 days from Cloudinary
// Runs daily at 2 AM
cron.schedule('0 2 * * *', async () => {
  try {
    console.log('🗑️ Starting auto-cleanup of 30+ day old videos...');
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    // Search for videos older than 30 days
    const result = await cloudinary.search
      .expression('folder:merged-videos AND created_at<' + thirtyDaysAgo.toISOString())
      .sort_by([['created_at', 'desc']])
      .max_results(100)
      .execute();
    
    for (const resource of result.resources) {
      try {
        await cloudinary.uploader.destroy(resource.public_id, { resource_type: 'video' });
        console.log(`🗑️ Deleted old video: ${resource.public_id}`);
      } catch (error) {
        console.error(`❌ Failed to delete ${resource.public_id}:`, error.message);
      }
    }
    
    console.log(`🗑️ Cleanup complete. Processed ${result.resources.length} old videos.`);
  } catch (error) {
    console.error('❌ Auto-cleanup error:', error.message);
  }
});

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
    
    // FFmpeg command to concatenate videos with quality preservation
    const ffmpegArgs = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy', // Copy streams without re-encoding (preserves quality)
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
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
// Enhanced upload function with multiple strategies
async function uploadToCloudinary(filePath, publicId) {
  try {
    console.log(`🚀 Enhanced upload starting: ${filePath}`);
    
    // Check file size for strategy selection
    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    console.log(`📊 Video file size: ${fileSizeMB.toFixed(2)}MB`);
    
    // Strategy 1: Very large files (>200MB) - Use streaming upload
    if (fileSizeMB > 200) {
      console.log('🌊 Very large file detected, using streaming upload...');
      return await uploadLargeFileWithStreaming(filePath, publicId);
    }
    
    // Strategy 2: Large files (100-200MB) - Use upload_large with chunking
    else if (fileSizeMB > 100) {
      console.log('📦 Large file detected, using chunked upload...');
      
      try {
        const result = await cloudinary.uploader.upload_large(filePath, {
          resource_type: 'video',
          public_id: publicId,
          folder: 'merged-videos',
          chunk_size: 6000000, // 6MB chunks
          eager_async: true,
          eager: [
            { 
              quality: 'auto:good', 
              format: 'mp4',
              video_codec: 'h264'
            }
          ],
          expiration: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
        });
        
        console.log(`✅ Chunked upload successful: ${result.secure_url}`);
        return result.secure_url;
      } catch (chunkError) {
        console.log('⚠️ Chunked upload failed, trying streaming fallback...');
        return await uploadLargeFileWithStreaming(filePath, publicId);
      }
    }
    
    // Strategy 3: Medium files (50-100MB) - Use async processing
    else if (fileSizeMB > 50) {
      console.log('🔄 Medium file detected, using async upload...');
      
      const result = await cloudinary.uploader.upload(filePath, {
        resource_type: 'video',
        public_id: publicId,
        folder: 'merged-videos',
        eager_async: true,
        eager: [
          { quality: 'auto', format: 'mp4' }
        ],
        expiration: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
      });
      
      console.log(`✅ Async upload successful: ${result.secure_url}`);
      return result.secure_url;
    }
    
    // Strategy 4: Small files (<50MB) - Use regular sync upload
    else {
      console.log('⚡ Small file detected, using sync upload...');
      
      const result = await cloudinary.uploader.upload(filePath, {
        resource_type: 'video',
        public_id: publicId,
        folder: 'merged-videos',
        quality: 'auto',
        format: 'mp4',
        expiration: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
      });
      
      console.log(`✅ Sync upload successful: ${result.secure_url}`);
      return result.secure_url;
    }
    
  } catch (error) {
    console.error(`❌ All upload strategies failed: ${error.message}`);
    
    // Final fallback: Try with minimal options and compression
    if (error.message.includes('too large') || error.message.includes('synchronously')) {
      console.log('🔧 Attempting final fallback with compression...');
      
      try {
        const result = await cloudinary.uploader.upload(filePath, {
          resource_type: 'video',
          public_id: publicId + '_compressed',
          folder: 'merged-videos',
          eager_async: true,
          quality: 'auto:low',
          video_codec: 'h264',
          bit_rate: '500k', // Very low bitrate
          fps: 24
        });
        
        console.log(`✅ Fallback upload successful: ${result.secure_url}`);
        return result.secure_url;
      } catch (fallbackError) {
        console.error(`❌ Final fallback also failed: ${fallbackError.message}`);
        throw new Error(`All upload methods failed. Original: ${error.message}, Fallback: ${fallbackError.message}`);
      }
    }
    
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

// Smart video compression function using fluent-ffmpeg
function compressVideoSmart(inputPath, outputPath, targetSizeMB = 90) {
  return new Promise((resolve, reject) => {
    console.log(`🎞️ Smart compression: targeting ${targetSizeMB}MB`);
    
    // Get video info first
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.error('FFprobe error:', err);
        return reject(err);
      }
      
      const duration = metadata.format.duration;
      const currentSizeMB = metadata.format.size / (1024 * 1024);
      
      // Calculate optimal bitrate
      const targetBitrate = Math.floor((targetSizeMB * 8 * 1024) / duration * 0.95); // 95% of target for safety
      
      console.log(`📊 Video duration: ${duration}s, Current: ${currentSizeMB.toFixed(2)}MB, Target bitrate: ${targetBitrate}k`);
      
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .videoBitrate(`${targetBitrate}k`)
        .audioBitrate('128k')
        .addOptions([
          '-preset fast',
          '-crf 23',
          '-profile:v baseline',
          '-level 3.0',
          '-pix_fmt yuv420p',
          '-movflags +faststart'
        ])
        .on('start', (commandLine) => {
          console.log('🎬 Compression started:', commandLine);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`🎞️ Compression progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log('✅ Video compression completed successfully');
          resolve();
        })
        .on('error', (err) => {
          console.error('❌ Compression error:', err);
          reject(err);
        })
        .save(outputPath);
    });
  });
}

// Stream-based upload for very large files
async function uploadLargeFileWithStreaming(filePath, publicId) {
  return new Promise((resolve, reject) => {
    console.log('🌊 Using streaming upload for very large file...');
    
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video',
        public_id: publicId,
        folder: 'merged-videos',
        chunk_size: 6000000, // 6MB chunks
        eager_async: true,
        eager: [
          { 
            quality: 'auto:low', 
            format: 'mp4',
            video_codec: 'h264',
            bit_rate: '1m'
          }
        ],
        expiration: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
      },
      (error, result) => {
        if (error) {
          console.error('Streaming upload error:', error);
          reject(error);
        } else {
          console.log('✅ Streaming upload successful:', result.secure_url);
          resolve(result.secure_url);
        }
      }
    );

    // Pipe file to upload stream
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(uploadStream);
    
    fileStream.on('error', (error) => {
      console.error('File stream error:', error);
      reject(error);
    });
  });
}

// Routes

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'FFmpeg Video Merger',
    version: '2.3.0',
    time: new Date().toISOString(),
    cloudinary: process.env.CLOUDINARY_CLOUD_NAME ? 'configured' : 'not configured',
    autoCleanup: 'enabled (30 days)',
    qualityPreservation: 'enabled',
    largeFileHandling: 'enhanced (compression + streaming + chunking)',
    uploadStrategies: ['sync (<50MB)', 'async (50-100MB)', 'chunked (100-200MB)', 'streaming (>200MB)']
  });
});

// API info endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'FFmpeg Video Merger API',
    version: '2.2.0',
    description: 'Merge videos and upload to Cloudinary with auto-cleanup and large file support',
    features: [
      'Video merging with quality preservation',
      'Cloudinary CDN hosting',
      'Auto-cleanup after 30 days',
      'Large file async processing (>100MB)',
      'n8n integration ready'
    ],
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
    
    // Calculate initial file size
    const outputStats = fs.statSync(outputPath);
    const initialFileSizeMB = outputStats.size / 1024 / 1024;
    
    console.log(`📊 Merged video size: ${initialFileSizeMB.toFixed(2)}MB`);
    
    let finalOutputPath = outputPath;
    let finalFileSizeMB = initialFileSizeMB;
    let compressionApplied = false;
    
    // Check if compression is needed for very large files
    if (initialFileSizeMB > 95) {
      console.log(`📦 File too large (${initialFileSizeMB.toFixed(2)}MB), attempting compression...`);
      
      try {
        const compressedPath = path.join(TEMP_DIR, `compressed_${sessionId}.mp4`);
        await compressVideoSmart(outputPath, compressedPath, 90);
        
        // Check if compression was successful
        if (fs.existsSync(compressedPath)) {
          const compressedStats = fs.statSync(compressedPath);
          const compressedSizeMB = compressedStats.size / 1024 / 1024;
          
          console.log(`📦 Compression complete: ${compressedSizeMB.toFixed(2)}MB`);
          
          // Use compressed version if it's significantly smaller
          if (compressedSizeMB < initialFileSizeMB * 0.8) {
            finalOutputPath = compressedPath;
            finalFileSizeMB = compressedSizeMB;
            compressionApplied = true;
            downloadedFiles.push(compressedPath); // Add to cleanup list
          } else {
            console.log('⚠️ Compression didn\'t reduce size significantly, using original');
            fs.unlinkSync(compressedPath); // Remove unsuccessful compression
          }
        }
      } catch (compressionError) {
        console.error('⚠️ Compression failed, using original file:', compressionError.message);
      }
    }
    
    const finalSize = `${finalFileSizeMB.toFixed(2)}MB`;
    
    // Upload to Cloudinary with enhanced strategies
    const publicId = `merged_${Date.now()}_${sessionId}`;
    const cloudinaryUrl = await uploadToCloudinary(finalOutputPath, publicId);
    
    // Clean up temporary files
    cleanupFiles([...downloadedFiles, outputPath]);

    // Determine upload strategy used
    let uploadStrategy = 'sync';
    if (finalFileSizeMB > 200) uploadStrategy = 'streaming';
    else if (finalFileSizeMB > 100) uploadStrategy = 'chunked';
    else if (finalFileSizeMB > 50) uploadStrategy = 'async';

    // Success response
    const response = {
      success: true,
      message: 'Videos merged successfully',
      videoUrl: cloudinaryUrl,
      publicId: publicId,
      videosProcessed: videoUrls.length,
      fileSize: finalSize,
      originalSize: compressionApplied ? `${initialFileSizeMB.toFixed(2)}MB` : finalSize,
      compressed: compressionApplied,
      autoDelete: '30 days',
      qualityPreservation: compressionApplied ? 'optimized' : 'preserved',
      uploadType: uploadStrategy,
      timestamp: new Date().toISOString()
    };

    console.log('🎉 Merge completed successfully:', response);
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
  console.log(`🚀 FFmpeg Video Merger API v2.2.0 running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 API info: http://localhost:${PORT}/`);
  console.log(`☁️  Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME ? 'Configured' : 'Not configured'}`);
  console.log(`🗑️ Auto-cleanup: Enabled (30 days)`);
  console.log(`🎥 Quality preservation: Enabled`);
  console.log(`📦 Large file handling: Enabled (async >100MB)`);
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
