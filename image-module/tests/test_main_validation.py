from fastapi.testclient import TestClient

from main import app


client = TestClient(app)


def test_analyze_rejects_empty_checks():
    response = client.post(
        "/api/v1/image/analyze",
        json={"image_url": "https://example.com/image.jpg", "checks": []},
    )
    assert response.status_code == 400
    assert "at least one" in str(response.json().get("error", ""))


def test_analyze_rejects_invalid_check_name():
    response = client.post(
        "/api/v1/image/analyze",
        json={"image_url": "https://example.com/image.jpg", "checks": ["quality", "invalid"]},
    )
    assert response.status_code == 400
    assert "Invalid checks" in str(response.json().get("error", ""))
