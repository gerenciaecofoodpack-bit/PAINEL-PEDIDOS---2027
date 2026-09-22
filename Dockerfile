# Imagem genérica, útil se você preferir Railway, Fly.io ou um servidor próprio com Docker
# em vez do Render (que não precisa deste arquivo, veja render.yaml).
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Onde o token do Bling fica salvo. Monte um volume persistente neste caminho
# (ex.: `fly volumes create` + `[mounts]` no fly.toml, ou um volume do Railway),
# senão a conexão com o Bling se perde a cada reinício do container.
VOLUME ["/app/server/.data"]

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
