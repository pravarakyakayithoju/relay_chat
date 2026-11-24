# One image for all three backend services (api, gateway, workers).
# Which one runs is chosen at start time with the APP environment variable,
# so `docker compose build` builds a single image and reuses it three times.
FROM node:22-alpine

WORKDIR /repo

# Copy only the package manifests first. Docker caches each step, so the slow
# `npm install` below is re-run only when a manifest changes, not on every code edit.
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/gateway/package.json apps/gateway/
COPY apps/workers/package.json apps/workers/
RUN npm install --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/gateway apps/gateway
COPY apps/workers apps/workers

# Do not run as root inside the container.
USER node

ENV APP=api
CMD ["sh", "-c", "npm run start -w apps/$APP"]
