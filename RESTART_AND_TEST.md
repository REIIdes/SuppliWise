# Critical Test - Restart Server Now

## What I Just Added

Enhanced logging to confirm the signature is being returned:

```javascript
console.log(`[recommend] ✅ Returning AI plan with signature: ${signature}`);
console.log(`[recommend] ✅ Returning fallback plan with signature: ${signature}`);
```

## Restart Server

```powershell
# Stop server (Ctrl+C)
cd server
node index.js
```

## Test ONE More Time

1. Submit Update Health Assessment (same answers)
2. **Watch for this NEW log line:**
   ```
   [recommend] ✅ Returning AI plan with signature: 5be1f1b73967f5e1eee1ca25
   ```
   OR
   ```
   [recommend] ✅ Returning fallback plan with signature: 5be1f1b73967f5e1eee1ca25
   ```

3. **Share the FULL server output** from the request, including:
   - The DEBUG canonicalized fields
   - The computed signature
   - The cache lookup result
   - The "✅ Returning" message
   - Any other messages

## What We're Checking

The database shows NO assessments with signature `5be1f1b73967f5e1eee1ca25`, which means either:

1. ❌ The recommend route isn't returning it in the response
2. ❌ The frontend isn't saving it to the database
3. ❌ Something is stripping it out

The new log will tell us if #1 is the problem.
