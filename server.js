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
    
    // Strategy 1: Very large files (>200MB) - Use streaming upload with proper async config
    if (fileSizeMB > 200) {
      console.log('🌊 Very large file detected, using streaming upload...');
      return await uploadLargeFileWithStreaming(filePath, publicId);
    }
    
    // Strategy 2: Large files (100-200MB) - Use upload_large with proper eager_async
    else if (fileSizeMB > 100) {
      console.log('📦 Large file detected, using chunked upload with eager_async...');
      
      try {
        const result = await cloudinary.uploader.upload_large(filePath, {
          resource_type: 'video',
          public_id: publicId,
          folder: 'merged-videos',
          chunk_size: 6000000, // 6MB chunks
          eager_async: true,
          eager: [
            { 
              format: 'mp4',
              video_codec: 'auto',
              quality: 'auto'
            }
          ],
          // Don't process synchronously - let Cloudinary handle async
          use_filename: false,
          unique_filename: true,
          expiration: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
        });
        
        console.log(`✅ Chunked upload successful: ${result.secure_url}`);
        return result.secure_url;
      } catch (chunkError) {
        console.log('⚠️ Chunked upload failed, trying streaming fallback...');
        return await uploadLargeFileWithStreaming(filePath, publicId);
      }
    }
    
    // Strategy 3: Medium files (50-100MB) - Use async processing with proper config
    else if (fileSizeMB > 50) {
      console.log('🔄 Medium file detected, using async upload...');
      
      const result = await cloudinary.uploader.upload(filePath, {
        resource_type: 'video',
        public_id: publicId,
        folder: 'merged-videos',
        eager_async: true,
        eager: [
          { 
            format: 'mp4',
            video_codec: 'auto',
            quality: 'auto'
          }
        ],
        use_filename: false,
        unique_filename: true,
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
    console.error(`❌ Upload strategy failed: ${error.message}`);
    
    // Final fallback: Use raw upload without any transformations
    if (error.message.includes('too large') || error.message.includes('synchronously')) {
      console.log('🔧 Attempting raw upload without transformations...');
      
      try {
        const result = await cloudinary.uploader.upload(filePath, {
          resource_type: 'video',
          public_id: publicId + '_raw',
          folder: 'merged-videos',
          // No eager transformations - just upload the file as-is
          use_filename: false,
          unique_filename: true,
          expiration: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
        });
        
        console.log(`✅ Raw upload successful: ${result.secure_url}`);
        return result.secure_url;
      } catch (rawError) {
        console.error(`❌ Raw upload also failed: ${rawError.message}`);
        
        // Last resort: Try unsigned upload
        try {
          console.log('🔧 Last resort: Trying unsigned upload...');
          const result = await cloudinary.uploader.unsigned_upload(filePath, 'ml_default', {
            resource_type: 'video',
            folder: 'merged-videos'
          });
          
          console.log(`✅ Unsigned upload successful: ${result.secure_url}`);
          return result.secure_url;
        } catch (unsignedError) {
          console.error(`❌ All upload methods failed: ${unsignedError.message}`);
          throw new Error(`All upload methods failed. Original: ${error.message}, Raw: ${rawError.message}, Unsigned: ${unsignedError.message}`);
        }
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

// Quality-preserving smart resize function - only reduces resolution, keeps quality
function resizeVideoSmart(inputPath, outputPath, maxWidth = 1280, maxHeight = 720) {
  return new Promise((resolve, reject) => {
    console.log(`📐 Smart resize: targeting max ${maxWidth}x${maxHeight} while preserving quality`);
    
    // Get video info first
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.error('FFprobe error:', err);
        return reject(err);
      }
      
      const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
      const currentWidth = videoStream.width;
      const currentHeight = videoStream.height;
      const currentSizeMB = metadata.format.size / (1024 * 1024);
      
      console.log(`📊 Current resolution: ${currentWidth}x${currentHeight}, Size: ${currentSizeMB.toFixed(2)}MB`);
      
      // Calculate new dimensions while maintaining aspect ratio
      let newWidth = currentWidth;
      let newHeight = currentHeight;
      
      if (currentWidth > maxWidth || currentHeight > maxHeight) {
        const aspectRatio = currentWidth / currentHeight;
        
        if (currentWidth > currentHeight) {
          newWidth = maxWidth;
          newHeight = Math.round(maxWidth / aspectRatio);
        } else {
          newHeight = maxHeight;
          newWidth = Math.round(maxHeight * aspectRatio);
        }
        
        // Ensure dimensions are even (required for h264)
        newWidth = newWidth % 2 === 0 ? newWidth : newWidth - 1;
        newHeight = newHeight % 2 === 0 ? newHeight : newHeight - 1;
      }
      
      console.log(`📐 New resolution: ${newWidth}x${newHeight}`);
      
      // If no resize needed, just copy the file
      if (newWidth === currentWidth && newHeight === currentHeight) {
        console.log('📐 No resize needed, file is already optimal size');
        fs.copyFileSync(inputPath, outputPath);
        resolve();
        return;
      }
      
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .size(`${newWidth}x${newHeight}`)
        .addOptions([
          '-preset slow',      // Better quality
          '-crf 18',           // High quality (lower = better)
          '-profile:v high',   // High profile for better compression
          '-level 4.0',
          '-pix_fmt yuv420p',
          '-movflags +faststart',
          '-avoid_negative_ts make_zero'
        ])
        .on('start', (commandLine) => {
          console.log('📐 Resize started:', commandLine);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`📐 Resize progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log('✅ Video resize completed successfully');
          resolve();
        })
        .on('error', (err) => {
          console.error('❌ Resize error:', err);
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
        // No eager transformations for very large files - just upload raw
        use_filename: false,
        unique_filename: true,
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
    version: '2.4.0',
    time: new Date().toISOString(),
    cloudinary: process.env.CLOUDINARY_CLOUD_NAME ? 'configured' : 'not configured',
    autoCleanup: 'enabled (30 days)',
    qualityPreservation: 'enhanced (smart resize + raw upload)',
    largeFileHandling: 'enhanced (resize > compression > raw upload)',
    uploadStrategies: ['sync (<50MB)', 'async (50-100MB)', 'chunked (100-200MB)', 'streaming (>200MB)', 'raw fallback']
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
    let processingApplied = false;
    let processingType = 'none';
    
    // For files >95MB, try quality-preserving resize first
    if (initialFileSizeMB > 95) {
      console.log(`📦 Large file detected (${initialFileSizeMB.toFixed(2)}MB), attempting quality-preserving resize...`);
      
      try {
        const resizedPath = path.join(TEMP_DIR, `resized_${sessionId}.mp4`);
        await resizeVideoSmart(outputPath, resizedPath, 1280, 720);
        
        // Check if resize was successful and reduced size
        if (fs.existsSync(resizedPath)) {
          const resizedStats = fs.statSync(resizedPath);
          const resizedSizeMB = resizedStats.size / 1024 / 1024;
          
          console.log(`� Resize complete: ${resizedSizeMB.toFixed(2)}MB`);
          
          // Use resized version if it's smaller or if original is very large
          if (resizedSizeMB < initialFileSizeMB || initialFileSizeMB > 150) {
            finalOutputPath = resizedPath;
            finalFileSizeMB = resizedSizeMB;
            processingApplied = true;
            processingType = 'resized';
            downloadedFiles.push(resizedPath); // Add to cleanup list
            
            console.log(`✅ Using resized version: ${finalFileSizeMB.toFixed(2)}MB`);
          } else {
            console.log('📐 Resize didn\'t help significantly, using original');
            fs.unlinkSync(resizedPath); // Remove unsuccessful resize
          }
        }
      } catch (resizeError) {
        console.error('⚠️ Resize failed, will try compression as fallback:', resizeError.message);
        
        // Only if resize fails AND file is still very large, try compression
        if (initialFileSizeMB > 120) {
          try {
            console.log(`🎞️ Fallback: Trying compression for very large file...`);
            const compressedPath = path.join(TEMP_DIR, `compressed_${sessionId}.mp4`);
            await compressVideoSmart(outputPath, compressedPath, 90);
            
            if (fs.existsSync(compressedPath)) {
              const compressedStats = fs.statSync(compressedPath);
              const compressedSizeMB = compressedStats.size / 1024 / 1024;
              
              console.log(`🎞️ Compression complete: ${compressedSizeMB.toFixed(2)}MB`);
              
              finalOutputPath = compressedPath;
              finalFileSizeMB = compressedSizeMB;
              processingApplied = true;
              processingType = 'compressed';
              downloadedFiles.push(compressedPath);
            }
          } catch (compressionError) {
            console.error('⚠️ Compression also failed, using original file:', compressionError.message);
          }
        }
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
      originalSize: processingApplied ? `${initialFileSizeMB.toFixed(2)}MB` : finalSize,
      processing: {
        applied: processingApplied,
        type: processingType,
        qualityPreserved: processingType === 'resized' || processingType === 'none'
      },
      autoDelete: '30 days',
      qualityPreservation: processingType === 'resized' ? 'high (resolution optimized)' : 
                           processingType === 'compressed' ? 'optimized (bitrate reduced)' : 'preserved',
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
