from services._json_utils import (
    extract_json_object,
    parse_llm_json,
    strip_code_fences,
)


def test_strip_code_fences_with_json_marker():
    text = "```json\n{\"a\": 1}\n```"
    assert strip_code_fences(text) == '{"a": 1}'


def test_strip_code_fences_no_marker():
    text = "```\n{\"a\": 1}\n```"
    assert strip_code_fences(text) == '{"a": 1}'


def test_strip_code_fences_passthrough():
    assert strip_code_fences('{"a": 1}') == '{"a": 1}'


def test_parse_llm_json_handles_fenced_json():
    assert parse_llm_json('```json\n{"primary": "Bedroom"}\n```') == {"primary": "Bedroom"}


def test_parse_llm_json_handles_chatty_prefix():
    raw = 'Sure! Here is the answer:\n{"primary": "Kitchen", "confidence": 88}'
    assert parse_llm_json(raw) == {"primary": "Kitchen", "confidence": 88}


def test_parse_llm_json_returns_none_on_garbage():
    assert parse_llm_json("not json at all") is None


def test_extract_json_object_finds_first_block():
    assert extract_json_object("prefix {\"a\": 1} suffix") == '{"a": 1}'
