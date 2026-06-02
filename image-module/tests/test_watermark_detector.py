from services.watermark_detector import WatermarkDetector, _parse_bool


def test_parse_bool_handles_string_false():
    assert _parse_bool("false", default=True) is False
    assert _parse_bool("0", default=True) is False


def test_parse_bool_handles_string_true():
    assert _parse_bool("true", default=False) is True
    assert _parse_bool("yes", default=False) is True


def test_fallback_marks_degraded():
    detector = WatermarkDetector()
    fallback = detector._fallback_response()
    assert fallback["degraded"] is True
    assert fallback["detected"] is False
