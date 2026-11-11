import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader:false,
  async headers(){return [{source:"/(.*)",headers:[
    {key:"X-Content-Type-Options",value:"nosniff"},
    {key:"X-Frame-Options",value:"DENY"},
    {key:"Referrer-Policy",value:"no-referrer"},
    {key:"Permissions-Policy",value:"camera=(), microphone=(), geolocation=()"},
    {key:"Content-Security-Policy",value:"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/"+(process.env.NODE_ENV!=="production"?" 'unsafe-eval'":"")+"; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://www.google.com/recaptcha/; frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/"},
  ]}]},
};

export default nextConfig;
