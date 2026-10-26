// Production origins (Vercel production domain, optional custom domain) are exact values injected by
// the Terraform-managed SSM deployment. Development keeps localhost on any port.
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const EXACT_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;

const configuredOrigins = (value = process.env.CORS_ORIGINS || '') => {
  const origins = value.split(',').map(origin => origin.trim()).filter(Boolean);
  const invalid = origins.filter(origin => !EXACT_ORIGIN.test(origin));
  if (invalid.length) throw new Error(`CORS_ORIGINS must contain exact https origins only: ${invalid.join(', ')}`);
  return new Set(origins);
};

const corsOptions = () => {
  const origins = configuredOrigins();
  const production = process.env.NODE_ENV === 'production';
  if (production && !origins.size) throw new Error('CORS_ORIGINS is required in production');
  return {
    exposedHeaders: ['Retry-After'],
    // Requests without Origin (health checks, server-to-server) need no CORS headers.
    origin: (origin, callback) => callback(null, !origin || origins.has(origin) || (!production && LOCAL_ORIGIN.test(origin))),
  };
};

module.exports = { corsOptions, configuredOrigins };
