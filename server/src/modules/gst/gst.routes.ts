import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, AppError } from '../../core/errors.js';

export const gstRouter = Router();

const SANDBOX_API_KEY = process.env.SANDBOX_API_KEY || 'key_live_97445b67772c4938a9559c5d8966946d';
const SANDBOX_API_SECRET = process.env.SANDBOX_API_SECRET || 'secret_live_25c6e0228c044b6498c4c2f4ada16b6f';
const SANDBOX_BASE_URL = process.env.SANDBOX_BASE_URL || 'https://api.sandbox.co.in';

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  // Reuse token if valid for at least 5 more minutes
  if (cachedToken && tokenExpiresAt > now + 5 * 60 * 1000) {
    return cachedToken;
  }

  const res = await fetch(`${SANDBOX_BASE_URL}/authenticate`, {
    method: 'POST',
    headers: {
      'x-api-key': SANDBOX_API_KEY,
      'x-api-secret': SANDBOX_API_SECRET,
      'x-api-version': '1.0.0',
      'Content-Type': 'application/json',
    },
  });

  const body = (await res.json()) as any;
  if (!res.ok || (!body?.data?.access_token && !body?.access_token)) {
    throw new AppError(
      res.status || 500,
      body?.message || 'Failed to authenticate with Sandbox GST API',
      'GST_AUTH_ERROR',
      body
    );
  }

  const token = body.data?.access_token || body.access_token;
  cachedToken = token;
  // Token validity is 24 hours, cache for 23 hours
  tokenExpiresAt = now + 23 * 60 * 60 * 1000;
  return token;
}

function formatAddressLines(addr: any) {
  if (!addr) {
    return {
      address_line1: '',
      address_line2: '',
      city: '',
      district: '',
      state: '',
      pincode: '',
    };
  }

  const line1Parts = [addr.flno, addr.bno, addr.bnm].filter(Boolean);
  const line2Parts = [addr.st, addr.loc].filter(Boolean);

  return {
    address_line1: line1Parts.join(', ') || addr.bnm || addr.st || '',
    address_line2: line2Parts.join(', ') || addr.loc || '',
    city: addr.dst || addr.loc || '',
    district: addr.dst || '',
    state: addr.stcd || '',
    pincode: addr.pncd || '',
  };
}

gstRouter.post(
  '/search',
  ah(async (req, res) => {
    const schema = z.object({
      gstin: z.string().trim().min(15).max(15),
    });

    const { gstin } = schema.parse(req.body);
    const token = await getAccessToken();

    const response = await fetch(`${SANDBOX_BASE_URL}/gst/compliance/public/gstin/search`, {
      method: 'POST',
      headers: {
        authorization: token,
        'x-api-key': SANDBOX_API_KEY,
        'x-api-version': '1.0.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ gstin: gstin.toUpperCase() }),
    });

    const result = (await response.json()) as any;

    if (!response.ok || (result.code && result.code !== 200)) {
      throw new AppError(
        response.status === 200 ? 400 : response.status,
        result.message || 'Failed to fetch GST details from portal',
        'GST_FETCH_ERROR',
        result
      );
    }

    const data = result.data?.data || result.data || {};
    const pradrAddr = data.pradr?.addr;
    const principalAddress = formatAddressLines(pradrAddr);

    const additionalAddresses = (data.adadr || []).map((item: any, idx: number) => {
      const formatted = formatAddressLines(item.addr);
      return {
        address_name: `Additional Place ${idx + 1}`,
        address_type: 'FACTORY' as const,
        ...formatted,
        nature_of_business: item.ntr || [],
      };
    });

    // Extract PAN from GSTIN (chars 3..12) or lgnm / data if available
    const pan = gstin.length === 15 ? gstin.substring(2, 12) : data.pan || '';

    res.json({
      success: true,
      data: {
        gstin: data.gstin || gstin.toUpperCase(),
        legal_name: data.lgnm || '',
        trade_name: data.tradeNam || '',
        party_name: data.tradeNam || data.lgnm || '',
        pan,
        status: data.sts || '',
        nature_of_business: data.nba || [],
        principal_address: {
          address_name: 'Principal Place of Business',
          address_type: 'REGISTERED' as const,
          ...principalAddress,
          nature_of_business: data.pradr?.ntr || [],
        },
        additional_addresses: additionalAddresses,
        raw: data,
      },
    });
  })
);
