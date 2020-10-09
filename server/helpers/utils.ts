import { recoverPersonalSignature } from 'cfx-sig-util';

export function jsonParse(input, fallback?) {
  try {
    return JSON.parse(input);
  } catch (err) {
    return fallback || {};
  }
}

export async function verify(address, msg, sig) {
  const data = `0x${Buffer.from(msg, 'utf8').toString('hex')}`
  const recovered = recoverPersonalSignature({ data, sig })
  return recovered === address;
}

export function clone(item) {
  return JSON.parse(JSON.stringify(item));
}

export function sendError(res, description) {
  return res.status(500).json({
    error: 'unauthorized',
    error_description: description
  });
}
