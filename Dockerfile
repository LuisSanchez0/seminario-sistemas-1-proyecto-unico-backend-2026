FROM node:22-alpine AS development
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "dev"]

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node app.js ./
COPY --chown=node:node config ./config
COPY --chown=node:node controllers ./controllers
COPY --chown=node:node database ./database
COPY --chown=node:node helpers ./helpers
COPY --chown=node:node middlewares ./middlewares
COPY --chown=node:node models ./models
COPY --chown=node:node routes ./routes
USER node
EXPOSE 8080
CMD ["node", "app.js"]
