"""Bedroom / legacy room tag normalization."""

from services.image_categorizer import ImageCategorizer, normalize_tag


def test_normalize_tag_maps_variants():
    assert normalize_tag("Room") == "room"
    assert normalize_tag("Bedroom") == "bedroom"


def test_sleeping_tags_include_room():
    assert "room" in ImageCategorizer.SLEEPING_TAGS
    assert "bedroom" in ImageCategorizer.SLEEPING_TAGS


def test_categories_list_has_no_room_output():
    assert "room" not in ImageCategorizer.CATEGORIES
