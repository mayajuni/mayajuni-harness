import pathlib
import sys
import unittest


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from recall import extract_recall_terms, rank_memory_candidates, trim_results_to_char_budget


class RecallRankingTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "recallBrowseMaxQueries": 6,
            "recallRankMaxTerms": 16,
            "recallMaxResults": 4,
            "recallMinLexicalScore": 6,
        }

    def test_extracts_technical_terms_and_bilingual_aliases(self):
        terms = extract_recall_terms("CTA 이미지 첨부 구현 맥락", max_queries=6)

        self.assertIn("cta", terms)
        self.assertIn("image", terms)
        self.assertIn("attachment", terms)
        self.assertNotIn("구현", terms)

    def test_drops_unrelated_semantic_result(self):
        candidates = [
            {
                "id": "relevant",
                "text": "CTA Agent stream interruption and tool status hardening",
                "fact_type": "observation",
                "tags": ["cta-agent", "streaming"],
            },
            {
                "id": "unrelated",
                "text": "법령 원문을 국가법령정보센터에서 확인해야 한다.",
                "fact_type": "observation",
                "tags": ["legal-references"],
            },
            {
                "id": "wrong-stream",
                "text": "Gemini streaming can hang when googleSearch is enabled.",
                "fact_type": "observation",
                "tags": ["streaming", "gemini"],
            },
        ]

        results = rank_memory_candidates(
            "CTA agent history stream interruption tool status",
            candidates,
            self.config,
        )

        self.assertEqual([result["id"] for result in results], ["relevant"])

    def test_uses_english_alias_to_recover_older_attachment_memory(self):
        candidates = [
            {
                "id": "attachment",
                "text": "Private AI tax image attachment storage uses signed CloudFront URLs.",
                "fact_type": "world",
                "tags": ["hangil-ai", "aws"],
            },
            {
                "id": "generic-ai-tax",
                "text": "AI 세무사 법령 원문 안내 문구를 수정했다.",
                "fact_type": "observation",
                "tags": ["legal-references"],
            },
        ]

        results = rank_memory_candidates("AI 세무사 이미지 첨부 구조를 다시 확인해줘", candidates, self.config)

        self.assertEqual([result["id"] for result in results], ["attachment"])

    def test_prefers_observation_when_duplicate_facts_exist(self):
        candidates = [
            {
                "id": "experience",
                "text": "CTA stream completion awaits onDone. | When: 2026-07-08",
                "fact_type": "experience",
            },
            {
                "id": "observation",
                "text": "CTA stream completion awaits onDone.",
                "fact_type": "observation",
            },
        ]

        results = rank_memory_candidates("CTA stream completion", candidates, self.config)

        self.assertEqual([result["id"] for result in results], ["observation"])

    def test_bounds_injected_memory_text(self):
        results = trim_results_to_char_budget(
            [{"id": "long", "text": "x" * 1000}],
            max_chars=240,
        )

        self.assertEqual(len(results), 1)
        self.assertLessEqual(len(results[0]["text"]), 240)
        self.assertTrue(results[0]["text"].endswith("..."))


if __name__ == "__main__":
    unittest.main()
