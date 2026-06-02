#!/bin/bash

# AI Content Audit System - Start Services Script

echo "=========================================="
echo "AI Content Audit System"
echo "Starting services..."
echo "=========================================="

# Check if .env file exists
if [ ! -f .env ]; then
    echo "Error: .env file not found!"
    echo "Please copy .env.example to .env and configure your credentials"
    exit 1
fi

# Start Image Module (Python/FastAPI) in background
echo ""
echo "Starting Image Module (Python/FastAPI)..."
cd image-module
if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate
pip install -q -r requirements.txt

echo "Image Module starting on port 8000..."
python -m uvicorn main:app --reload --port 8000 &
IMAGE_MODULE_PID=$!
echo "Image Module PID: $IMAGE_MODULE_PID"

cd ..

# Wait for Image Module to start
echo "Waiting for Image Module to be ready..."
sleep 5

# Start API Service (Node.js/Express) in background
echo ""
echo "Starting API Service (Node.js/Express)..."
cd api

if [ ! -d "node_modules" ]; then
    echo "Installing Node.js dependencies..."
    npm install
fi

echo "API Service starting on port 3000..."
npm run dev &
API_PID=$!
echo "API Service PID: $API_PID"

cd ..

echo ""
echo "=========================================="
echo "Services started successfully!"
echo "=========================================="
echo "Image Module: http://localhost:8000"
echo "API Service:  http://localhost:3000"
echo ""
echo "Health checks:"
echo "  curl http://localhost:8000/health"
echo "  curl http://localhost:3000/health"
echo ""
echo "Press Ctrl+C to stop all services"
echo "=========================================="

# Wait for Ctrl+C
trap "echo 'Stopping services...'; kill $IMAGE_MODULE_PID $API_PID; exit" INT
wait
