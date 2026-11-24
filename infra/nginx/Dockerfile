# Stage 1: build the React app into static files.
FROM node:22-alpine AS web
WORKDIR /repo
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm install --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w apps/web

# Stage 2: Nginx serves those files and proxies /api and /ws to the backend.
# Only the built files are copied over, so the final image contains no Node.js.
FROM nginx:1.27-alpine
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=web /repo/apps/web/dist /usr/share/nginx/html
