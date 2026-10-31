# Local build: docker build -f orchestra/Dockerfile -t agent-orchestra:local .
# Instrument samples are fetched at build time and checked against orchestra/sounds.json.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS sounds
WORKDIR /app
COPY orchestra/sounds.json orchestra/fetch-sounds.mjs ./orchestra/
RUN node orchestra/fetch-sounds.mjs

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
ENV NODE_ENV=production PORT=4480 HOST=0.0.0.0 TRUST_PROXY=0
WORKDIR /app
COPY --chown=node:node reader.py ./reader.py
COPY --chown=node:node orchestra/server.mjs orchestra/geo.mjs orchestra/shop.mjs orchestra/orders.mjs orchestra/stripe.mjs orchestra/admin.mjs orchestra/webp.mjs ./orchestra/
COPY --chown=node:node orchestra/geo/ ./orchestra/geo/
COPY --chown=node:node orchestra/web/ ./orchestra/web/
COPY --from=sounds --chown=node:node /app/orchestra/web/sounds/ ./orchestra/web/sounds/
USER node
EXPOSE 4480
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD node -e "fetch('http://127.0.0.1:4480/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "orchestra/server.mjs"]
