import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest } from '../../core/errors.js';

export const uploadRouter = Router();

const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};

uploadRouter.post('/', ah(async (req, res) => {
  const schema = z.object({
    filename: z.string().trim().min(1).default('image.png'),
    data: z.string().min(1), // Data URI (e.g. data:image/jpeg;base64,...) or raw base64
    folder: z.enum(['styles', 'documents', 'attachments']).default('styles'),
  });

  const { filename, data, folder } = schema.parse(req.body);

  let base64Content = data;
  let extension = path.extname(filename).toLowerCase();
  let mimeType = 'image/png';

  // Parse Data URI if present
  const dataUriMatch = data.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
  if (dataUriMatch) {
    mimeType = dataUriMatch[1].toLowerCase();
    base64Content = dataUriMatch[2];
    if (ALLOWED_MIME_TYPES[mimeType]) {
      extension = ALLOWED_MIME_TYPES[mimeType];
    }
  } else if (!extension) {
    extension = '.png';
  }

  if (extension && !['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'].includes(extension)) {
    throw BadRequest('Invalid image file format. Supported formats: PNG, JPG, JPEG, WEBP, GIF, SVG.');
  }

  const buffer = Buffer.from(base64Content, 'base64');
  if (buffer.length === 0) {
    throw BadRequest('Uploaded image file is empty');
  }

  // Max 10MB limit
  if (buffer.length > 10 * 1024 * 1024) {
    throw BadRequest('Image size exceeds 10MB limit');
  }

  const cleanBaseName = path.basename(filename, path.extname(filename))
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 40) || 'image';

  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const finalFilename = `${Date.now()}_${cleanBaseName}_${randomSuffix}${extension}`;

  const targetDir = path.resolve(process.cwd(), 'uploads', folder);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const filePath = path.join(targetDir, finalFilename);
  fs.writeFileSync(filePath, buffer);

  const publicUrl = `/uploads/${folder}/${finalFilename}`;

  res.status(201).json({
    data: {
      url: publicUrl,
      filename: finalFilename,
      originalName: filename,
      size: buffer.length,
      mimeType,
    },
  });
}));
