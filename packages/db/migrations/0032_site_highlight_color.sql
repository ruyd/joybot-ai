-- Website setup: a second brand color for highlighted cards (border, tint, label, bullets and button)
-- and the hero's glow. Blank means the gradient color (accent_to). Kept apart from the gradient so a
-- warm second color does not end up behind white button text.

ALTER TABLE core.site_settings ADD COLUMN highlight_color text CHECK (highlight_color ~ '^#[0-9a-f]{6}$');
