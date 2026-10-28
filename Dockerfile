
# ==============================
# DEVELOPMENT
# ==============================
FROM node:22-alpine AS development

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Crear directorio temporal
RUN mkdir -p /app/tmp

CMD ["npm", "run", "dev"]


# ==============================
# PRODUCTION
# ==============================
FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

# Copiar solamente los archivos necesarios
COPY --chown=node:node app.js ./
COPY --chown=node:node config ./config
COPY --chown=node:node controllers ./controllers
COPY --chown=node:node database ./database
COPY --chown=node:node helpers ./helpers
COPY --chown=node:node middlewares ./middlewares
COPY --chown=node:node models ./models
COPY --chown=node:node routes ./routes

# Directorio temporal para imágenes y comprobantes
RUN mkdir -p /app/tmp \
    && chown node:node /app/tmp

# Ejecutar sin privilegios de root
USER node

EXPOSE 8080

CMD ["node", "app.js"]
