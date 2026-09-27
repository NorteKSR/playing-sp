# Playing SP EBS (Extension Backend Service) - production image.
# Build context: this backend/ directory.  No secrets are baked in: all configuration comes from env vars
# (set them as platform secrets, e.g. `fly secrets set ...`).  The app has zero npm dependencies.
FROM node:20-alpine

# su-exec: tiny setuid helper used by the entrypoint to drop from root to the unprivileged "node" user
# after fixing ownership of the mounted volume (platform volumes are mounted root-owned).
RUN apk add --no-cache su-exec

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts/gen-secrets.js ./scripts/gen-secrets.js
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data && chown node:node /data && chmod 700 /data

# Persistent encrypted token store (tokens.json) lives here - mount a volume at /data.
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
