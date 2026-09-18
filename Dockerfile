# Build stage
FROM node:20-alpine AS build

RUN apk add --no-cache python3 make g++ pkgconfig

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (use npm install for better compatibility)
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build-time public env vars (Vite inlines these into the bundle)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PROJECT_ID
ARG VITE_API_URL
ARG BUILD_COMMIT
ARG BUILD_COMMIT_SHORT
ARG BUILD_TIME
ARG BUILD_ID
ARG BUILD_DIRTY
ENV BUILD_COMMIT=$BUILD_COMMIT
ENV BUILD_COMMIT_SHORT=$BUILD_COMMIT_SHORT
ENV BUILD_TIME=$BUILD_TIME
ENV BUILD_ID=$BUILD_ID
ENV BUILD_DIRTY=$BUILD_DIRTY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID
ENV VITE_API_URL=$VITE_API_URL

# Build the application
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Expose port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
