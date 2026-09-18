#!/bin/bash

# Script para gerar uma nova versão (release) do sistema
# Uso: ./scripts/release.sh [versão]

# Usa SemVer do package.json e o commit para identificar o release.
PACKAGE_VERSION=$(node -p "require('./package.json').version")
COMMIT=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short HEAD)
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
VERSION=${1:-"${PACKAGE_VERSION}-${COMMIT_SHORT}"}

export BUILD_ID="$VERSION"
echo "🚀 Iniciando release versão: $VERSION"

# 1. Build do Frontend
echo "📦 Construindo imagem do Frontend..."
docker build -t app-frontend:$VERSION -f Dockerfile \
  --build-arg BUILD_COMMIT="$COMMIT" \
  --build-arg BUILD_COMMIT_SHORT="$COMMIT_SHORT" \
  --build-arg BUILD_TIME="$BUILD_TIME" \
  --build-arg BUILD_ID="$VERSION" \
  .
docker tag app-frontend:$VERSION app-frontend:latest

# 2. Build do Backend
echo "📦 Construindo imagem do Backend..."
cd backend
docker build -t app-backend:$VERSION -f Dockerfile .
docker tag app-backend:$VERSION app-backend:latest
cd ..

echo "✅ Imagens construídas com sucesso!"
echo "-----------------------------------"
echo "Para rodar em produção:"
echo "1. Certifique-se de que o arquivo .env em ./backend está configurado."
echo "2. Execute: VERSION=$VERSION docker-compose up -d"
echo ""
echo "Para fazer ROLLBACK para esta versão no futuro:"
echo "Execute: VERSION=$VERSION docker-compose up -d"
echo "-----------------------------------"

# Sugestão de exportar para .tar caso não use registro
read -p "Deseja exportar as imagens para arquivos .tar? (s/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Ss]$ ]]; then
    mkdir -p releases/$VERSION
    echo "💾 Exportando app-frontend:$VERSION para releases/$VERSION/frontend.tar..."
    docker save app-frontend:$VERSION > releases/$VERSION/frontend.tar
    echo "💾 Exportando app-backend:$VERSION para releases/$VERSION/backend.tar..."
    docker save app-backend:$VERSION > releases/$VERSION/backend.tar
    echo "✨ Arquivos salvos em ./releases/$VERSION/"
fi
