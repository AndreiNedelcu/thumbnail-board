import unittest
from jev_tagger import parse_answers

class JevTest(unittest.TestCase):
    def test_only_valid_confident_taxonomy_tags_are_accepted(self):
        answers = {'style-minimal': {'noul': .95}, 'mood-happy': {'noul': .5}, 'fake-tag': {'noul': 1}, 'text-number': {'noul': float('nan')}, 'element-chart': {'noul': True}}
        result = parse_answers(answers, ['style-minimal', 'mood-happy', 'text-number', 'element-chart'])
        self.assertEqual(result['tags'], ['style-minimal'])
        self.assertEqual(result['uncertain_tags'], ['mood-happy'])
        self.assertEqual(len(result['tag_confidence']), 2)

if __name__ == '__main__':
    unittest.main()
