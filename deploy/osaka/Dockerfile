FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS runtime
WORKDIR /app

FROM nginx:1.29-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/osaka/container-nginx.conf /etc/nginx/conf.d/default.conf
