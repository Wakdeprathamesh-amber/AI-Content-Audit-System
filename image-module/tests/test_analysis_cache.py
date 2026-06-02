from services.analysis_cache import AnalysisCache


def test_get_returns_none_on_miss():
    c = AnalysisCache()
    assert c.get("hash-1", ["quality"], None) is None


def test_set_then_get_returns_value():
    c = AnalysisCache()
    c.set("hash-1", ["quality", "watermark"], None, {"primary": "Bedroom"})
    got = c.get("hash-1", ["quality", "watermark"], None)
    assert got == {"primary": "Bedroom"}


def test_key_is_check_order_insensitive():
    c = AnalysisCache()
    c.set("hash-1", ["quality", "watermark"], None, {"x": 1})
    assert c.get("hash-1", ["watermark", "quality"], None) == {"x": 1}


def test_existing_tag_changes_the_key():
    c = AnalysisCache()
    c.set("hash-1", ["category"], "Bedroom", {"primary": "Bedroom"})
    assert c.get("hash-1", ["category"], "Kitchen") is None
    assert c.get("hash-1", ["category"], "Bedroom") == {"primary": "Bedroom"}


def test_returns_copy_not_reference():
    c = AnalysisCache()
    c.set("hash-1", ["quality"], None, {"primary": "Bedroom"})
    got = c.get("hash-1", ["quality"], None)
    got["primary"] = "Kitchen"
    assert c.get("hash-1", ["quality"], None) == {"primary": "Bedroom"}


def test_no_hash_no_cache():
    c = AnalysisCache()
    c.set(None, ["quality"], None, {"primary": "Bedroom"})
    # Storing with no hash is a no-op; lookup also returns None.
    assert c.get(None, ["quality"], None) is None
