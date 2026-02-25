# Koldly Custom Domain Setup (koldly.com)

## Status
✅ App Configuration: READY
⏳ DNS Configuration: REQUIRES USER ACTION
⏳ SSL/HTTPS: PENDING (auto-provisions after DNS)

## What's Done

### Environment Variables (✅ Configured)
The following environment variables are already set in production:
- `APP_URL=https://koldly.com` (used in email templates, API responses, canonical URLs)
- `FROM_EMAIL=noreply@koldly.com` (used for all outbound emails)

These drive all app references to use the custom domain. Changes are live immediately on app restarts.

### Application Code (✅ Ready)
- Email templates updated to reference koldly.com
- API responses use APP_URL environment variable
- Redirect middleware enforces canonical origin (koldly.com)
- All internal links point to /dashboard, /campaigns, etc. (domain-agnostic)

## What You Need to Do

### Step 1: Add Domain to Render Service
Contact the infrastructure team or access Render Dashboard:
1. Go to https://dashboard.render.com/
2. Select the "reachkit" web service
3. Go to Settings → Custom Domains
4. Add domain: `koldly.com`
5. Also add: `www.koldly.com` (optional)

### Step 2: Configure DNS at Your Registrar
Render will provide DNS records like:
```
Type: A
Name: @ (or blank)
Value: <Render's IP>

Type: CNAME
Name: www
Value: cname.render.com
```

Add these records at your domain registrar (GoDaddy, Namecheap, Route53, etc.)

### Step 3: Disable Domain Forwarding (Important)
If your registrar provides domain forwarding, **disable it**. This can interfere with the A record.

### Step 4: Wait for DNS Propagation
- DNS changes can take 15 minutes to 2 hours to propagate globally
- Check propagation: `dig koldly.com` or use whatsmydns.net
- Render will auto-provision SSL once DNS resolves correctly

### Step 5: Verify Setup
Once DNS propagates:
```bash
# Test HTTP → HTTPS redirect
curl -L http://koldly.com

# Verify SSL certificate
curl -I https://koldly.com

# Test app routes
curl https://koldly.com/settings
curl https://koldly.com/dashboard
```

## Troubleshooting

### Cloudflare Error 1001 "DNS Points to Wrong Place"
- DNS records are correct BUT domain not registered in Render's system
- Solution: Make sure domain was added in Render Dashboard Settings

### SSL Certificate Not Provisioning
- DNS propagation can take up to 2 hours for new domains
- Check: `dig koldly.com +short` should return Render's IP
- Wait 10 minutes and try accessing https://koldly.com

### Emails Still Sent from koldly.polsia.app
- Email templates use FROM_EMAIL environment variable (already set)
- But DKIM/SPF records also matter - add these to DNS:
  ```
  SPF: v=spf1 include:sendgrid.net ~all
  DKIM: (provided by your email service)
  ```

## DNS Records Summary

| Type | Name | Value | Purpose |
|------|------|-------|---------|
| A | @ | [Render IP] | Direct domain to Koldly |
| CNAME | www | cname.render.com | WWW subdomain |
| TXT | @ | v=spf1 include:sendgrid.net ~all | Email authentication |

## Rollback (if needed)
If you need to switch back to koldly.polsia.app:
1. Update ENV: `APP_URL=https://koldly.polsia.app`
2. Redeploy app
3. Remove custom domain from Render (optional)

All app behavior will revert to using the polsia.app domain.

---

**Next Steps:**
1. Contact Polsia infrastructure team to add koldly.com to Render
2. Update DNS at registrar
3. Allow 15-60 minutes for SSL provisioning
4. Verify with: `curl -I https://koldly.com`
