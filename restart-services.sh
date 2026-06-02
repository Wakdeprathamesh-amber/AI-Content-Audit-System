#!/bin/bash

# Restart Services Script - AI Content Audit System
# Restarts both Image Module and API to pick up code changes

set -e

echo "🔄 Restarting AI Content Audit System Services..."
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Kill existing processes
echo "${BLUE}Stopping existing services...${NC}"
pkill -f "uvicorn main:app" || echo "Image module not running"
pkill -f "ts-node-dev" || echo "API not running"
sleep 2

echo ""
echo "${GREEN}✓ Services stopped${NC}"
echo ""

# Start Image Module in background
echo "${BLUE}Starting Image Module (port 8000)...${NC}"
cd image-module
source venv/bin/activate
nohup python -m uvicorn main:app --reload --port 8000 > ../logs/image-module.log 2>&1 &
IMAGE_PID=$!
echo "Image Module PID: $IMAGE_PID"
cd ..

sleep 3

# Start API in background
echo "${BLUE}Starting API (port 3000)...${NC}"
cd api
nohup npm run dev > ../logs/api.log 2>&1 &
API_PID=$!
echo "API PID: $API_PID"
cd ..

sleep 5

echo ""
echo "${GREEN}✓ Services started${NC}"
echo ""

# Health checks
echo "${BLUE}Running health checks...${NC}"
echo ""

# Check Image Module
echo "Checking Image Module..."
if curl -s http://localhost:8000/health | grep -q "healthy"; then
    echo "${GREEN}✓ Image Module is healthy${NC}"
else
    echo "❌ Image Module health check failed"
    echo "Check logs: tail -f logs/image-module.log"
fi

echo ""

# Check API
echo "Checking API..."
if curl -s http://localhost:3000/health | grep -q "healthy"; then
    echo "${GREEN}✓ API is healthy${NC}"
else
    echo "❌ API health check failed"
    echo "Check logs: tail -f logs/api.log"
fi

echo ""
echo "${GREEN}========================================${NC}"
echo "${GREEN}Services restarted successfully!${NC}"
echo "${GREEN}========================================${NC}"
echo ""
echo "Image Module: http://localhost:8000"
echo "API: http://localhost:3000"
echo "Web UI: http://localhost:3000/"
echo ""
echo "Logs:"
echo "  Image Module: tail -f logs/image-module.log"
echo "  API: tail -f logs/api.log"
echo ""
echo "To stop services:"
echo "  pkill -f 'uvicorn main:app'"
echo "  pkill -f 'ts-node-dev'"
