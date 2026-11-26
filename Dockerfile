# Servidor Node que sirve la aplicación y expone la API sobre Postgres.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Las dependencias se instalan antes de copiar el resto: así Railway reutiliza
# esta capa y los despliegues de solo-HTML son mucho más rápidos.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY index.html sw.js ./

# No correr como root dentro del contenedor
USER node

EXPOSE 8080
CMD ["node", "server.js"]
