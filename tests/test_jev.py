import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest import mock

import jev_tagger
from jev_tagger import parse_answers

spec = importlib.util.spec_from_file_location('jev_eval', Path(__file__).resolve().parent.parent / 'tools' / 'jev-eval.py')
jev_eval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jev_eval)

class JevTest(unittest.TestCase):
    def test_only_valid_confident_taxonomy_tags_are_accepted(self):
        answers = {'style-minimal': {'noul': .95}, 'mood-happy': {'noul': .5}, 'fake-tag': {'noul': 1}, 'text-number': {'noul': float('nan')}, 'element-chart': {'noul': True}}
        result = parse_answers(answers, ['style-minimal', 'mood-happy', 'text-number', 'element-chart'])
        self.assertEqual(result['tags'], ['style-minimal'])
        self.assertEqual(result['uncertain_tags'], ['mood-happy'])
        self.assertEqual(len(result['tag_confidence']), 2)

    def test_requests_follow_documented_system_one_shape_and_count_usage(self):
        calls = []
        def fake_post(url, body, headers=None, timeout=120):
            calls.append((url, body, headers))
            if 'localhost' in url:
                return {'response': 'Large red text "I QUIT". One surprised man, close-up.'}
            answers = {name: {'type': 'noul', 'noul': 0.9 if name == 'mood-surprised' else 0.1} for name in body['questions'] if name != 'visual_quality'}
            if 'visual_quality' in body['questions']:
                answers['visual_quality'] = {'type': 'score', 'score': 2.6, 'confidence': 0.7}
            return {'model': 'jev-1.13.0', 'answers': answers, 'usage': {'input_tokens': 500, 'output_tokens': 20}}
        tags = [f'element-t{i}' for i in range(30)] + ['mood-surprised']
        with mock.patch.dict(os.environ, {'TYPESAFE_API_KEY': 'test-key'}), mock.patch.object(jev_tagger, 'post_json', fake_post):
            result = jev_tagger.analyze_thumbnail('aW1n', tags)
        jev_calls = [c for c in calls if 'typesafe' in c[0]]
        self.assertEqual(len(jev_calls), 2)
        url, body, headers = jev_calls[0]
        self.assertEqual((url, body['model'], headers['Authorization']), ('https://api.typesafe.ai/v1/systemone', 'jev-latest', 'Bearer test-key'))
        quality = body['questions']['visual_quality']
        self.assertEqual(quality['type'], 'score')
        self.assertTrue(2 <= len(quality['criteria']) <= 10)
        self.assertNotIn('aW1n', json.dumps(body))  # Jev never receives the image
        self.assertEqual(result['tags'], ['mood-surprised'])
        self.assertEqual((result['visual_quality'], result['jev_input_tokens']), (2.6, 1000))
        self.assertTrue(result['needs_review'])

    def test_evaluation_scores_against_approved_visual_tags_only(self):
        taxonomy = {'style-minimal', 'mood-happy', 'text-number'}
        item = {'id': 'abcdefghijk', 'title': 'T', 'tags': ['style-minimal', 'mood-happy', 'channel-x', 'topic-custom']}
        row = jev_eval.compare(item, {'tags': ['style-minimal', 'text-number'], 'visual_quality': 3.0, 'jev_input_tokens': 1000}, taxonomy, {'abcdefghijk'})
        self.assertEqual((row['matched'], row['extra'], row['missed']), (['style-minimal'], ['text-number'], ['mood-happy']))
        inbox = jev_eval.compare({'id': 'bbbbbbbbbbb', 'tags': []}, {'tags': ['mood-happy'], 'visual_quality': 1.0}, taxonomy, set())
        summary = jev_eval.summarize([row, inbox])
        self.assertEqual((summary['precision'], summary['recall'], summary['with_human_tags']), (0.5, 0.5, 1))
        self.assertEqual((summary['visual_quality_saved'], summary['visual_quality_other']), (3.0, 1.0))
        self.assertIn('abcdefghijk', jev_eval.render_html({'source': 'board', 'created_at': 'now', 'summary': summary, 'rows': [row, inbox]}))

    def test_sample_splits_saved_and_other_items(self):
        items = [{'id': f'id{i:09d}'} for i in range(20)]
        saved = {items[0]['id'], items[1]['id'], items[2]['id']}
        picked = jev_eval.sample(items, 6, saved, 1)
        self.assertEqual(len(picked), 6)
        self.assertEqual(sum(v['id'] in saved for v in picked), 3)


if __name__ == '__main__':
    unittest.main()
