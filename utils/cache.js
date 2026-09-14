// Simple in-memory cache for backend
class SimpleCache {
  constructor() {
    this.cache = new Map();
    this.defaultTTL = 5 * 60 * 1000; // 5 minutes
  }

  set(key, value, ttl = this.defaultTTL) {
    const expiresAt = Date.now() + ttl;
    this.cache.set(key, { value, expiresAt });
    
    // Clean up expired entries periodically
    if (this.cache.size > 100) {
      this.cleanup();
    }
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return item.value;
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  size() {
    return this.cache.size;
  }

  /** Drop every entry whose key starts with `prefix`. */
  clearPrefix(prefix) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
}

// Global cache instance
const globalCache = new SimpleCache();

// Cache middleware for API responses
const withCache = (handler, cacheKey, ttl = 5 * 60 * 1000) => {
  return async (req, res) => {
    // Check cache first
    const cached = globalCache.get(cacheKey);
    if (cached) {
      console.log(`📦 Cache hit for ${cacheKey}`);
      return res.json(cached);
    }

    // Store original res.json
    const originalJson = res.json;
    let responseData = null;

    // Override res.json to capture response
    res.json = function(data) {
      responseData = data;
      return originalJson.call(this, data);
    };

    // Call original handler
    await handler(req, res);

    // Cache the response if successful
    if (responseData && res.statusCode === 200) {
      globalCache.set(cacheKey, responseData, ttl);
      console.log(`💾 Cached response for ${cacheKey}`);
    }
  };
};

/**
 * Short server-side cache for public, read-only JSON that is the same for every visitor
 * (therapist list, packages, CMS pages, slots). Each of those answers costs one or more
 * database round trips (~350 ms each from far regions) and they were re-run on every page
 * view. Keyed by the full URL; only successful answers are kept; `?preview` is never
 * cached. Any successful write on the API clears all of it — see clearPublicCacheOnWrite.
 */
const PUBLIC_PREFIX = 'public:';
const cachePublic = (ttlMs) => (req, res, next) => {
  if (req.query && req.query.preview) return next();
  const key = `${PUBLIC_PREFIX}${req.originalUrl}`;
  const hit = globalCache.get(key);
  if (hit) {
    res.set('X-Cache', 'HIT');
    return res.status(200).json(hit);
  }
  const send = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200 && body && body.success !== false) globalCache.set(key, body, ttlMs);
    res.set('X-Cache', 'MISS');
    return send(body);
  };
  next();
};

/** A successful POST/PUT/PATCH/DELETE (booking, payment, admin/CMS edit) invalidates the public cache. */
const clearPublicCacheOnWrite = (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode < 400) globalCache.clearPrefix(PUBLIC_PREFIX);
    });
  }
  next();
};

module.exports = {
  globalCache,
  withCache,
  SimpleCache,
  cachePublic,
  clearPublicCacheOnWrite
};









































