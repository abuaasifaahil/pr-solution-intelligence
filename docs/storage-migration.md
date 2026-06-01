# Storage migration runbook — MinIO → AWS S3

The Phase 2 storage layer is an abstraction over an S3-compatible adapter. Local dev uses **MinIO**; the free-tier prod baseline uses `STORAGE_MODE=inmemory` (zero persistence). When prod needs durable object storage, flip to **AWS S3** with zero code changes — only env vars move.

## Decision points

- The same `lib/storage.s3.ts` adapter services both MinIO and AWS S3. The wire protocol is identical.
- Migration is **reversible**: setting `STORAGE_MODE=inmemory` falls back to the bytes-discarded mode.
- Rotating `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` does **not** invalidate already-uploaded objects (unlike `ENCRYPTION_KEY` — that one destroys data on rotation).

## Steps

### 1. Create the AWS bucket

```bash
aws s3api create-bucket \
  --bucket prsi-uploads-prod \
  --region us-east-1
```

For regions other than `us-east-1`, add `--create-bucket-configuration LocationConstraint=<region>`.

Block **all** public access — these uploads are private:

```bash
aws s3api put-public-access-block \
  --bucket prsi-uploads-prod \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Enable default server-side encryption (AES-256, no KMS cost):

```bash
aws s3api put-bucket-encryption \
  --bucket prsi-uploads-prod \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

### 2. Generate an IAM user with least privilege

Create an IAM user `prsi-api-storage`. Attach a policy that allows only `PutObject`, `GetObject`, `DeleteObject`, and `ListBucket` on **this one bucket**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::prsi-uploads-prod"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::prsi-uploads-prod/*"
    }
  ]
}
```

Create an access key for that user. Treat the secret like any other credential — password manager only, never in code or chat logs.

### 3. Flip the Render env vars

In the Render dashboard, on the `prsi-api` service:

| Var | Value |
|---|---|
| `STORAGE_MODE` | `s3` |
| `STORAGE_REGION` | `us-east-1` (or your bucket's region) |
| `STORAGE_BUCKET` | `prsi-uploads-prod` |
| `STORAGE_ACCESS_KEY` | the IAM user's access key id |
| `STORAGE_SECRET_KEY` | the IAM user's secret access key |
| `STORAGE_FORCE_PATH_STYLE` | `false` |
| `STORAGE_ENDPOINT` | **clear / leave blank** |

Save. Render auto-redeploys; the new pod boots with the S3 adapter wired up.

### 4. Smoke test

Upload a probe via the API and confirm it lands in the bucket:

```bash
curl -F file=@/tmp/probe.csv -F chatId=$CHAT_ID -H "Authorization: Bearer $TOKEN" \
  https://prsi-api.onrender.com/api/v1/uploads
aws s3 ls s3://prsi-uploads-prod/uploads/
```

Phase 2's upload route (M7.3, `POST /api/v1/uploads`) accepts the file as a single multipart/form-data part with `file` + `chatId` fields and streams it directly to the configured storage adapter — there are NO presigned URLs in Phase 2. The cap is 50 MB (enforced by `@fastify/multipart` and the route handler).

If the cutover succeeds, you'll see `uploads/<userId>/<uploadId>/<filename>` keys in the bucket listing.

### 5. Rolling back

If anything goes sideways, set `STORAGE_MODE=inmemory` and redeploy. New uploads will fall through to the bytes-discarded mode; previously-stored S3 objects stay in the bucket but won't be readable from the app until you flip back. This is non-destructive — the AWS bucket is untouched.

## Cost watch

- AWS S3 standard storage: ~$0.023/GB/month + ~$0.005 per 1k PUT requests. A free-tier-equivalent ~5 GB workload runs ~$0.15/month.
- Set a bucket lifecycle rule that expires objects older than 90 days (or whatever the Phase 2 retention policy demands) to keep the bill bounded.

## Related

- `app/backend/src/lib/storage.ts` — adapter interface
- `app/backend/src/lib/storage.s3.ts` — S3 implementation (MinIO + AWS, single code path)
- `app/backend/src/lib/storage.inmemory.ts` — bytes-discarded baseline
- `app/.env.example` — env var template
