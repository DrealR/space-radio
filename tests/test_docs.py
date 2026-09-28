"""Release documentation stays aligned with Space Radio's runtime defaults."""
import unittest
from pathlib import Path

from spaces_radio.budget import DEFAULT_CREW_DAILY_CAP, DEFAULT_CREW_SPACE_CAP, DEFAULT_DAILY_CAP
from spaces_radio.service import FRESH_SECONDS

ROOT = Path(__file__).resolve().parents[1]


def env_example():
    values = {}
    for line in (ROOT / ".env.example").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


class ReleaseDocumentationTests(unittest.TestCase):
    def test_documented_caps_match_defaults_and_shared_vercel_ledgers(self):
        configured = env_example()
        caps = {
            "SPACES_RADIO_DAILY_CAP": DEFAULT_DAILY_CAP,
            "SPACES_RADIO_CREW_SPACE_CAP": DEFAULT_CREW_SPACE_CAP,
            "SPACES_RADIO_CREW_DAILY_CAP": DEFAULT_CREW_DAILY_CAP,
        }
        self.assertEqual(caps, {
            "SPACES_RADIO_DAILY_CAP": 0.60,
            "SPACES_RADIO_CREW_SPACE_CAP": 0.10,
            "SPACES_RADIO_CREW_DAILY_CAP": 0.40,
        })
        self.assertAlmostEqual(sum(caps.values()), 1.10)
        self.assertEqual({key: float(configured[key]) for key in caps}, caps)

        readme = " ".join((ROOT / "README.md").read_text().split())
        self.assertIn("60¢ bands + 10¢ crew rooms + 40¢ names = **$1.10/day** by default", readme)
        self.assertIn("every instance adds up to one real daily cap", readme)
        self.assertIn("these ledgers live in the one shared tank", readme)
        self.assertIn("SPACES_RADIO_CREW_DAILY_CAP` (default **$0.40** of names)", readme)
        self.assertIn("SPACES_RADIO_CREW_SPACE_CAP` (default **$0.10** of Space reads", readme)

    def test_story_cdn_lifetime_matches_tune_route(self):
        readme = (ROOT / "README.md").read_text()
        story = (ROOT / "STORY.md").read_text()
        self.assertEqual(FRESH_SECONDS, 1800)
        self.assertIn(f"Vercel-CDN-Cache-Control: max-age={FRESH_SECONDS}", readme)
        self.assertIn(f"answer cached {FRESH_SECONDS // 60} min on Vercel's CDN", story)


if __name__ == "__main__":
    unittest.main()
