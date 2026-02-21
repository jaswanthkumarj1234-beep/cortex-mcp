# Cortex Operations Runbook

Standard procedures for operating and maintaining the Cortex AI platform.

---

## 1. Deployment

### Deploy Website (cortex-website)
```bash
# Push to main → Vercel auto-deploys
git push origin main

# Verify deployment
curl -s https://cortex-website-theta.vercel.app/api/health | jq .
```

### Publish NPM Package (cortex-mcp)
```bash
# 1. Update version
npm version patch  # or minor/major

# 2. Push tag → triggers GitHub Actions release
git push --follow-tags

# 3. Verify on npm
npm info cortex-mcp version
```

---

## 2. Credential Rotation

### Rotate JWT Secret
1. Generate new secret: `openssl rand -hex 32`
2. Update in Vercel: Project → Settings → Environment Variables → `JWT_SECRET`
3. Redeploy: Vercel dashboard → Deployments → Redeploy
4. **Impact:** All existing user sessions invalidated (users must re-login)

### Rotate Database Password
1. Go to Neon dashboard → Connection Details → Reset Password
2. Copy new connection string
3. Update in Vercel: `DATABASE_URL` env var
4. Redeploy
5. **Impact:** Brief ~30s downtime during redeploy

### Rotate Google OAuth Credentials
1. Go to Google Cloud Console → Credentials
2. Create new OAuth 2.0 Client ID
3. Update in Vercel: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
4. Delete old credentials from Google Console
5. Redeploy
6. **Impact:** None if done quickly

### Rotate LemonSqueezy Keys
1. Go to LemonSqueezy dashboard → Settings → API Keys
2. Create new API key
3. Update in Vercel: `LEMONSQUEEZY_API_KEY`
4. Update webhook secret: `LEMONSQUEEZY_WEBHOOK_SECRET`
5. Redeploy
6. **Impact:** Failed payment processing during rotation

---

## 3. Incident Response

### Website Down
1. Check Vercel status: https://www.vercel-status.com/
2. Check health endpoint: `curl https://cortex-website-theta.vercel.app/api/health`
3. Check Vercel deployment logs: Project → Deployments → Latest
4. If Vercel is up but site is down → check DNS / domain settings
5. Roll back: Vercel dashboard → Deployments → select last working → "Promote to Production"

### Database Issues
1. Check Neon dashboard: https://console.neon.tech
2. Verify connection: Use Neon SQL Editor to run `SELECT 1`
3. Check for connection limits (free tier: 5 connections)
4. If corrupted, use Neon's Point-in-Time Recovery (PITR)

### NPM Package Issues
1. Check npm status: https://status.npmjs.org/
2. Verify package: `npm info cortex-mcp`
3. If broken publish → `npm unpublish cortex-mcp@VERSION` (within 72 hours)
4. Fix and republish with patch version bump

---

## 4. Monitoring Checks

### Daily
- [ ] Check Vercel deployment status
- [ ] Review any error logs in Vercel dashboard

### Weekly
- [ ] Run `npm audit` on both repos
- [ ] Check npm download stats
- [ ] Review GitHub issues/PRs

### Monthly
- [ ] Update dependencies: `npm update`
- [ ] Review Neon database usage (storage, connections)
- [ ] Check LemonSqueezy payment dashboard
- [ ] Review Google OAuth usage quotas

---

## 5. Common Operations

### Add a New User Manually (SQL)
```sql
INSERT INTO users (id, email, name, provider)
VALUES (gen_random_uuid(), 'user@example.com', 'User Name', 'manual');

INSERT INTO licenses (id, user_id, plan, status, license_key)
VALUES (gen_random_uuid(), '<user_id>', 'PRO', 'ACTIVE', 'CORTEX-XXXX-XXXX-XXXX-XXXX');
```

### Revoke a License
```sql
UPDATE licenses SET plan = 'FREE', status = 'REVOKED' WHERE license_key = 'CORTEX-XXXX-...';
```

### Check Active Subscriptions
```sql
SELECT u.email, l.plan, l.status, l.license_key
FROM users u JOIN licenses l ON u.id = l.user_id
WHERE l.status = 'ACTIVE' ORDER BY l.created_at DESC;
```
