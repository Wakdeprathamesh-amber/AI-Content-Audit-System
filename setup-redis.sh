#!/bin/bash

# Redis Setup Script for AI Content Audit System

echo "=========================================="
echo "Redis Setup for AI Content Audit System"
echo "=========================================="
echo ""

# Check if Redis is installed
if command -v redis-server &> /dev/null; then
    echo "✅ Redis is already installed"
    redis-server --version
else
    echo "❌ Redis is not installed"
    echo ""
    echo "Installing Redis..."
    
    # Detect OS
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command -v brew &> /dev/null; then
            echo "Installing Redis via Homebrew..."
            brew install redis
        else
            echo "❌ Homebrew not found. Please install Homebrew first:"
            echo "   /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
            exit 1
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        if command -v apt-get &> /dev/null; then
            echo "Installing Redis via apt-get..."
            sudo apt-get update
            sudo apt-get install -y redis-server
        elif command -v yum &> /dev/null; then
            echo "Installing Redis via yum..."
            sudo yum install -y redis
        else
            echo "❌ Package manager not found. Please install Redis manually."
            exit 1
        fi
    else
        echo "❌ Unsupported OS: $OSTYPE"
        exit 1
    fi
fi

echo ""
echo "=========================================="
echo "Starting Redis Server"
echo "=========================================="
echo ""

# Start Redis
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    echo "Starting Redis via brew services..."
    brew services start redis
    echo "✅ Redis started"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    echo "Starting Redis service..."
    sudo systemctl start redis
    sudo systemctl enable redis
    echo "✅ Redis started"
fi

echo ""
echo "=========================================="
echo "Testing Redis Connection"
echo "=========================================="
echo ""

# Wait for Redis to start
sleep 2

# Test connection
if redis-cli ping | grep -q "PONG"; then
    echo "✅ Redis is running and responding"
else
    echo "❌ Redis is not responding"
    exit 1
fi

echo ""
echo "=========================================="
echo "Redis Setup Complete!"
echo "=========================================="
echo ""
echo "Redis is now running on:"
echo "  Host: localhost"
echo "  Port: 6379"
echo ""
echo "To stop Redis:"
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  brew services stop redis"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "  sudo systemctl stop redis"
fi
echo ""
echo "To check Redis status:"
echo "  redis-cli ping"
echo ""
echo "To view Redis info:"
echo "  redis-cli info"
echo ""
