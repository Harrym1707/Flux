# Builds a TINY, FAKE token-classification model (not LLMLingua, no training):
# logits = embedding-table lookup. Only used to exercise the real
# transformers.js + onnxruntime-node code path offline in
# packages/sdk-js/src/hf-compactor.integration.test.ts. Its scores mean nothing.
#
# Regenerate: python3 -m venv .venv && .venv/bin/pip install onnx numpy &&
#   .venv/bin/python packages/sdk-js/fixtures/make_tiny_model.py packages/sdk-js/fixtures/tiny-lingua
import json, os, sys
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

out = sys.argv[1]
os.makedirs(os.path.join(out, "onnx"), exist_ok=True)

special = ["[PAD]", "[UNK]", "[CLS]", "[SEP]"]
fillers = ["the", "um", "so", "basically", "just", "really", "very", "that", "was", "and", "a", "is"]
content = ["job", "step", "finish", "##ed", "output", "fine", "report", "running", "error", "build", "src", "/", ".", ":", "ts", "index", "1", "2", "3", "7", "4"]
vocab = special + fillers + content
table = np.zeros((len(vocab), 2), dtype=np.float32)
for i, tok in enumerate(vocab):
    table[i] = [0.0, -2.0 if tok in fillers else 2.0 + 0.1 * (i % 5)]

ids = helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "L"])
mask = helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, "L"])
logits = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, "L", 2])
graph = helper.make_graph(
    [helper.make_node("Gather", ["table", "input_ids"], ["logits"], axis=0)],
    "tiny_token_clf", [ids, mask], [logits], [numpy_helper.from_array(table, "table")],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, os.path.join(out, "onnx", "model.onnx"))

tokenizer = {
    "version": "1.0",
    "truncation": None,
    "padding": None,
    "added_tokens": [{"id": i, "content": t, "single_word": False, "lstrip": False, "rstrip": False, "normalized": False, "special": True} for i, t in enumerate(special)],
    "normalizer": {"type": "BertNormalizer", "clean_text": True, "handle_chinese_chars": True, "strip_accents": None, "lowercase": False},
    "pre_tokenizer": {"type": "BertPreTokenizer"},
    "post_processor": {
        "type": "TemplateProcessing",
        "single": [{"SpecialToken": {"id": "[CLS]", "type_id": 0}}, {"Sequence": {"id": "A", "type_id": 0}}, {"SpecialToken": {"id": "[SEP]", "type_id": 0}}],
        "pair": [{"SpecialToken": {"id": "[CLS]", "type_id": 0}}, {"Sequence": {"id": "A", "type_id": 0}}, {"SpecialToken": {"id": "[SEP]", "type_id": 0}}, {"Sequence": {"id": "B", "type_id": 1}}, {"SpecialToken": {"id": "[SEP]", "type_id": 1}}],
        "special_tokens": {"[CLS]": {"id": "[CLS]", "ids": [2], "tokens": ["[CLS]"]}, "[SEP]": {"id": "[SEP]", "ids": [3], "tokens": ["[SEP]"]}},
    },
    "decoder": {"type": "WordPiece", "prefix": "##", "cleanup": True},
    "model": {"type": "WordPiece", "unk_token": "[UNK]", "continuing_subword_prefix": "##", "max_input_chars_per_word": 100, "vocab": {t: i for i, t in enumerate(vocab)}},
}
json.dump(tokenizer, open(os.path.join(out, "tokenizer.json"), "w"))
json.dump({"tokenizer_class": "BertTokenizer", "cls_token": "[CLS]", "sep_token": "[SEP]", "unk_token": "[UNK]", "pad_token": "[PAD]", "model_max_length": 512}, open(os.path.join(out, "tokenizer_config.json"), "w"))
json.dump({"model_type": "bert", "architectures": ["BertForTokenClassification"], "id2label": {"0": "LABEL_0", "1": "LABEL_1"}, "label2id": {"LABEL_0": 0, "LABEL_1": 1}, "vocab_size": len(vocab)}, open(os.path.join(out, "config.json"), "w"))
print("wrote", out, "vocab", len(vocab))
