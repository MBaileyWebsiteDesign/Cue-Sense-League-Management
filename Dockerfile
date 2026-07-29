# ---- Stage 1: build the React (Vite) client ----
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ---- Stage 2: server runtime ----
# Serves the API and the built client (server/src/index.js serves
# client/dist as static files when it exists on disk - see CLIENT_DIST).
FROM node:20-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/ ./
COPY --from=client-build /app/client/dist /app/client/dist

ENV NODE_ENV=production
# Fly.io routes traffic to this port (see fly.toml's internal_port) -
# server/src/index.js reads process.env.PORT, defaulting to 4000 locally.
ENV PORT=4000
EXPOSE 4000

CMD ["npm", "start"]
