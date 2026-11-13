const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const fs = require('fs');

// Initialize S3 client if config is available
let s3Client = null;
const isSpacesConfigured =
  process.env.SPACES_KEY &&
  process.env.SPACES_KEY !== 'placeholder_key' &&
  process.env.SPACES_SECRET &&
  process.env.SPACES_SECRET !== 'placeholder_secret';

if (isSpacesConfigured) {
  s3Client = new S3Client({
    endpoint: process.env.SPACES_ENDPOINT || 'https://nyc3.digitaloceanspaces.com',
    region: 'us-east-1', // Required by S3 SDK but ignored by Spaces
    credentials: {
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET,
    },
  });
}

// @desc    Generate a presigned upload URL
// @route   POST /api/media/upload-url
// @access  Private
exports.getUploadUrl = async (req, res) => {
  const { fileName, fileType } = req.body;

  if (!fileName || !fileType) {
    return res.status(400).json({ message: 'fileName and fileType are required' });
  }

  const uniqueFileName = `${Date.now()}-${fileName}`;

  try {
    if (isSpacesConfigured && s3Client) {
      // Production path: DigitalOcean Spaces
      const bucketName = process.env.SPACES_BUCKET || 'nexora';
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: uniqueFileName,
        ContentType: fileType,
        ACL: 'public-read',
      });

      const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 }); // Valid for 5 minutes
      const downloadUrl = `${process.env.SPACES_ENDPOINT}/${bucketName}/${uniqueFileName}`;

      return res.json({
        uploadUrl,
        downloadUrl,
        isMock: false,
      });
    } else {
      // Local fallback development path
      const host = req.get('host');
      const protocol = req.protocol;
      
      const uploadUrl = `${protocol}://${host}/api/media/mock-upload/${uniqueFileName}`;
      const downloadUrl = `${protocol}://${host}/uploads/${uniqueFileName}`;

      return res.json({
        uploadUrl,
        downloadUrl,
        isMock: true,
      });
    }
  } catch (error) {
    console.error('Error generating upload URL', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Local development upload endpoint (for when DO Spaces is not configured)
// @route   PUT /api/media/mock-upload/:fileName
// @access  Public (matches direct PUT behaviour of S3 presigned URLs)
exports.mockUpload = async (req, res) => {
  const { fileName } = req.params;
  const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');

  // Ensure directory exists
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const filePath = path.join(uploadDir, fileName);
  const writeStream = fs.createWriteStream(filePath);

  req.pipe(writeStream);

  req.on('end', () => {
    res.status(200).json({ message: 'Uploaded successfully', fileName });
  });

  req.on('error', (err) => {
    console.error('Upload stream error:', err);
    res.status(500).json({ message: 'Upload failed' });
  });
};
