# Certificate Management Changes

## Summary

Updated the action to manually create certificates via the App Store Connect API with a unique identifier embedded in the Certificate Signing Request (CSR). This ensures reliable certificate cleanup in the post action, even when multiple CI jobs run in parallel.

## Problem Solved

Previously, the action relied on finding certificates by serial number or by the "Created via API" name pattern. This caused issues:

- Race conditions when multiple jobs ran simultaneously
- Certificates not found if already deleted by another job
- Unreliable matching when serial numbers weren't unique enough

## Solution

### Certificate Creation (Main Action)

1. **Generate Unique Identifier**: Create a UUID for each certificate
2. **Create CSR with Unique CN**: Embed the UUID in the Common Name field as `GHA-{UUID}`
3. **Submit to App Store Connect API**: Create the certificate via API
4. **Import to Keychain**: Convert to PKCS12 and import for code signing
5. **Store Identifier**: Save the UUID in GitHub Actions state for cleanup

### Certificate Cleanup (Post Action)

1. **Retrieve Unique Identifier**: Get the UUID from saved state
2. **Find in Local Keychain**: Search for certificate with matching CN `GHA-{UUID}`
3. **Delete from Keychain**: Remove using certificate hash
4. **Find in App Store Connect**: Query API and match by CN in certificate content
5. **Revoke from API**: Delete the certificate from App Store Connect

## Key Benefits

- **Unique Identification**: Each job creates a certificate with a globally unique identifier
- **No Race Conditions**: Each job only deletes its own certificate
- **Reliable Cleanup**: CN-based matching is deterministic and collision-free
- **Graceful Failures**: If certificate is already gone, cleanup succeeds silently

## Technical Details

### CSR Subject Format

```
/CN=GHA-{UUID}/O=GitHub Actions/C=US
```

Example:

```
/CN=GHA-A1B2C3D4-E5F6-7890-ABCD-EF1234567890/O=GitHub Actions/C=US
```

### State Management

- `certificateUniqueId`: The UUID used in the CN
- `apiKeyId`: App Store Connect API key ID
- `apiKeyIssuerId`: App Store Connect API issuer ID
- `keychainPath`: Path to temporary keychain

### API Endpoints Used

- `POST /v1/certificates` - Create certificate
- `GET /v1/certificates` - List certificates
- `DELETE /v1/certificates/{id}` - Revoke certificate

## Files Modified

- `src/lib.ts`: Added `createCertificateViaApi()`, `createKeychainForApi()`, `generateJwtToken()`, and updated `deleteApiCreatedCertificates()`
- `src/index.ts`: Added certificate creation call when using API key authentication

## Testing Recommendations

1. Test single job execution
2. Test parallel matrix builds
3. Test job cancellation (ensure post action still runs)
4. Verify certificates are cleaned up in App Store Connect
5. Check for orphaned certificates after multiple runs
