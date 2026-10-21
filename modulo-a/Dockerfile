FROM node:18-alpine

WORKDIR /app

# Copiar manifiestos e instalar dependencias
COPY package*.json ./
RUN npm install --only=production

# Copiar el código fuente
COPY . .

# Exponer el puerto del Gateway
EXPOSE 8080

CMD ["npm", "start"]