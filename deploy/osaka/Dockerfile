FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS runtime
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser
ENV CLOAKBROWSER_VERSION=146.0.7680.177.5
RUN ./node_modules/.bin/playwright install --with-deps chromium
RUN ./node_modules/.bin/cloakbrowser install

FROM nginx:1.29-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/osaka/container-nginx.conf /etc/nginx/conf.d/default.conf
