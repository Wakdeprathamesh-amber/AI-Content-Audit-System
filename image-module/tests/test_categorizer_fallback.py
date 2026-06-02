"""
Categorizer fallback / JSON-parsing tests.

We don't make real OpenAI calls. Instead we exercise the parsing helpers and
the public fallback contract.
"""

from services._json_utils import parse_llm_json
from services.image_categorizer import ImageCategorizer


def test_fallback_confidence_is_below_category_gate():
    """The category gate is 70%. Fallback used to return 70% which passed the
    gate — silently masking parse failures. It must now be below the gate."""
    c = ImageCategorizer()
    fb = c._fallback_response("Bedroom")
    assert fb["confidence"] < 70.0
    # Existing tag is normalized to canonical lowercase_underscore.
    assert fb["existing_tag"] == "bedroom"


def test_fallback_keys_match_success_shape():
    """All keys the engine reads must exist on the fallback object too."""
    c = ImageCategorizer()
    fb = c._fallback_response()
    for k in [
        "primary",
        "confidence",
        "alternatives",
        "existing_tag",
        "is_tag_correct",
        "suggested_correction",
        "reasoning",
    ]:
        assert k in fb


def test_parse_llm_json_handles_fenced_categorizer_output():
    """The bug we fixed: categorizer didn't strip code fences. Make sure the
    shared helper does."""
    fenced = '```json\n{"primary": "Kitchen", "confidence": 92}\n```'
    parsed = parse_llm_json(fenced)
    assert parsed == {"primary": "Kitchen", "confidence": 92}
