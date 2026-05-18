#!/usr/bin/env python3
import argparse
import json
import os
import posixpath
import re
import struct
import sys
import zipfile
import xml.etree.ElementTree as ET


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "v": "urn:schemas-microsoft-com:vml",
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
}
REL_NS = {"rel": "http://schemas.openxmlformats.org/package/2006/relationships"}
FIGURE_ANY_RE = re.compile(r"(?:fig(?:ure)?\.?\s*([0-9]+[A-Za-z]?))|(?:图\s*([0-9]+[A-Za-z]?))", re.I)
FIGURE_CAPTION_RE = re.compile(r"^\s*(?:(fig(?:ure)?\.?)\s*([0-9]+[A-Za-z]?)|图\s*([0-9]+[A-Za-z]?))\b", re.I)


def image_dimensions(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return {"width": struct.unpack(">I", data[16:20])[0], "height": struct.unpack(">I", data[20:24])[0]}
    if data.startswith(b"\xff\xd8"):
        index = 2
        while index + 9 < len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            index += 2
            if marker in (0xD8, 0xD9):
                continue
            if index + 2 > len(data):
                break
            length = struct.unpack(">H", data[index:index + 2])[0]
            if marker in range(0xC0, 0xC4) or marker in range(0xC5, 0xC8) or marker in range(0xC9, 0xCC) or marker in range(0xCD, 0xD0):
                if index + 7 <= len(data):
                    return {
                        "width": struct.unpack(">H", data[index + 5:index + 7])[0],
                        "height": struct.unpack(">H", data[index + 3:index + 5])[0],
                    }
                break
            index += max(length, 2)
    if data.startswith(b"GIF8") and len(data) >= 10:
        return {"width": struct.unpack("<H", data[6:8])[0], "height": struct.unpack("<H", data[8:10])[0]}
    return {"width": None, "height": None}


def xml_root(zip_file, name):
    try:
        return ET.fromstring(zip_file.read(name))
    except Exception:
        return None


def paragraph_texts(root):
    if root is None:
        return []
    paragraphs = []
    for record in paragraph_records(root):
        value = record["text"]
        if value:
            paragraphs.append(value)
    return paragraphs


def paragraph_records(root):
    if root is None:
        return []
    records = []
    for index, paragraph in enumerate(root.findall(".//w:p", NS)):
        texts = [node.text or "" for node in paragraph.findall(".//w:t", NS)]
        records.append({"index": index, "element": paragraph, "text": "".join(texts).strip()})
    return records


def truncate_text(text, limit=500):
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(value) <= limit:
        return value
    return f"{value[:limit]}..."


def normalize_zip_target(target):
    if not target:
        return None
    if target.startswith("/"):
        return posixpath.normpath(target.lstrip("/"))
    return posixpath.normpath(posixpath.join("word", target))


def document_relationships(zip_file):
    root = xml_root(zip_file, "word/_rels/document.xml.rels")
    if root is None:
        return {}
    relationships = {}
    for rel in root.findall("rel:Relationship", REL_NS):
        rel_id = rel.attrib.get("Id")
        target = rel.attrib.get("Target")
        if not rel_id:
            continue
        relationships[rel_id] = {
            "target": normalize_zip_target(target),
            "raw_target": target,
            "type": rel.attrib.get("Type"),
            "target_mode": rel.attrib.get("TargetMode"),
        }
    return relationships


def paragraph_image_relationship_ids(paragraph):
    rel_ids = []
    for blip in paragraph.findall(".//a:blip", NS):
        rel_id = blip.attrib.get(f"{{{NS['r']}}}embed") or blip.attrib.get(f"{{{NS['r']}}}link")
        if rel_id:
            rel_ids.append(rel_id)
    for image_data in paragraph.findall(".//v:imagedata", NS):
        rel_id = image_data.attrib.get(f"{{{NS['r']}}}id")
        if rel_id:
            rel_ids.append(rel_id)
    return rel_ids


def nearby_text(records, paragraph_index, direction, limit=3):
    values = []
    index = paragraph_index + direction
    while 0 <= index < len(records) and len(values) < limit:
        text = records[index]["text"]
        if text:
            values.append(text)
        index += direction
    if direction < 0:
        values.reverse()
    return truncate_text(" / ".join(values))


def figure_label_from_text(text, caption_only=False):
    if not text:
        return None
    match = FIGURE_CAPTION_RE.search(text) if caption_only else FIGURE_ANY_RE.search(text)
    if not match:
        return None
    number = next((group for group in match.groups() if group and re.search(r"\d", group)), None)
    if not number:
        return None
    prefix = "图" if match.group(0).lstrip().startswith("图") else "Figure "
    return f"{prefix}{number}" if prefix == "图" else f"Figure {number}"


def infer_caption(records, paragraph_index):
    search_offsets = [0, 1, -1, 2, -2, 3, -3]
    for offset in search_offsets:
        candidate_index = paragraph_index + offset
        if candidate_index < 0 or candidate_index >= len(records):
            continue
        text = records[candidate_index]["text"]
        label = figure_label_from_text(text, caption_only=True)
        if label:
            confidence = "high" if abs(offset) <= 1 else "medium"
            return {
                "caption_text": truncate_text(text),
                "inferred_label": label,
                "label_confidence": confidence,
            }

    for offset in search_offsets:
        candidate_index = paragraph_index + offset
        if candidate_index < 0 or candidate_index >= len(records):
            continue
        text = records[candidate_index]["text"]
        label = figure_label_from_text(text, caption_only=False)
        if label:
            return {
                "caption_text": truncate_text(text),
                "inferred_label": label,
                "label_confidence": "low",
            }

    return {"caption_text": None, "inferred_label": None, "label_confidence": "none"}


def extracted_image_path(extract_dir, image_id, media_path, data):
    if not extract_dir or data is None:
        return None
    os.makedirs(extract_dir, exist_ok=True)
    ext = os.path.splitext(media_path or "")[1].lower() or ".bin"
    destination = os.path.abspath(os.path.join(extract_dir, f"{image_id}{ext}"))
    with open(destination, "wb") as file:
        file.write(data)
    return destination


def build_image_sequence(zip_file, root, media_names, extract_dir):
    relationships = document_relationships(zip_file)
    records = paragraph_records(root)
    sequence = []
    occurrence_index = 0

    for record in records:
        rel_ids = paragraph_image_relationship_ids(record["element"])
        for rel_id in rel_ids:
            occurrence_index += 1
            image_id = f"img_{occurrence_index:03d}"
            rel = relationships.get(rel_id, {})
            media_path = rel.get("target")
            data = zip_file.read(media_path) if media_path in media_names else None
            dims = image_dimensions(data) if data is not None else {"width": None, "height": None}
            extracted_path = extracted_image_path(extract_dir, image_id, media_path, data)
            caption = infer_caption(records, record["index"])
            sequence.append({
                "image_id": image_id,
                "document_order": occurrence_index,
                "relationship_id": rel_id,
                "extracted_path": extracted_path,
                "media_path": media_path,
                "width": dims["width"],
                "height": dims["height"],
                "nearby_text_before": nearby_text(records, record["index"], -1),
                "nearby_text_after": nearby_text(records, record["index"], 1),
                "caption_text": caption["caption_text"],
                "inferred_label": caption["inferred_label"],
                "label_confidence": caption["label_confidence"],
                "placement_confidence": "high" if extracted_path else "low",
                "review_status": "pending_manual_review" if extracted_path else "not_reviewable",
            })

    return sequence


def label_numeric_value(label):
    if not label:
        return None
    match = re.search(r"(\d+)", label)
    return int(match.group(1)) if match else None


def add_sequence_quality_flags(result):
    sequence = result.get("image_sequence") or []
    figure_caption_count = result["counts"].get("figure_caption_like", 0)
    occurrence_count = result["counts"].get("image_occurrences", 0)

    if occurrence_count and figure_caption_count and occurrence_count != figure_caption_count:
        result["quality_flags"].append({
            "level": "P2",
            "code": "figure_image_caption_count_mismatch",
            "message": f"检测到 {occurrence_count} 个图片 occurrence 与 {figure_caption_count} 条 Figure/图线索，数量不一致，需人工复核图注和正文引用。",
        })

    labels = [
        (item["document_order"], label_numeric_value(item.get("inferred_label")), item.get("inferred_label"))
        for item in sequence
        if item.get("inferred_label") and item.get("label_confidence") in ("high", "medium")
    ]
    numeric_labels = [(order, value, label) for order, value, label in labels if value is not None]
    if numeric_labels:
        values = [value for _, value, _ in numeric_labels]
        if values != sorted(values):
            result["quality_flags"].append({
                "level": "P2",
                "code": "figure_label_order_mismatch",
                "message": "图片在 Word 主文档 XML 中的出现顺序与推断 Figure 编号顺序不一致，需人工复核正文、图注和文末图片组织。",
            })
        duplicates = sorted({value for value in values if values.count(value) > 1})
        if duplicates:
            result["quality_flags"].append({
                "level": "P2",
                "code": "duplicate_inferred_figure_label",
                "message": f"检测到重复推断 Figure 编号：{', '.join(str(value) for value in duplicates)}，需人工复核。",
            })

    unmatched_count = len([item for item in sequence if not item.get("inferred_label")])
    if unmatched_count:
        result["notes"].append(f"{unmatched_count} 个图片 occurrence 未匹配明确 Figure label，仅保留 img_00x 稳定编号。")


def analyze_docx(path, extract_dir=None):
    result = {
        "schema_version": "artifact_manifest.v1",
        "file_path": os.path.abspath(path),
        "file_name": os.path.basename(path),
        "file_type": os.path.splitext(path)[1].lower().lstrip("."),
        "file_size_bytes": os.path.getsize(path),
        "extraction_status": "ok",
        "extracted_images_dir": os.path.abspath(extract_dir) if extract_dir else None,
        "counts": {
            "images": 0,
            "image_occurrences": 0,
            "tables": 0,
            "drawings": 0,
            "inline_drawings": 0,
            "anchor_drawings": 0,
            "legacy_pict": 0,
            "charts": 0,
            "diagrams": 0,
            "figure_captions": 0,
            "figure_caption_like": 0,
            "table_captions": 0,
        },
        "images": [],
        "image_sequence": [],
        "captions": {"figures": [], "figure_caption_like": [], "tables": []},
        "quality_flags": [],
        "notes": [],
    }

    if result["file_type"] != "docx":
        result["extraction_status"] = "limited_non_docx"
        result["quality_flags"].append({
            "level": "P2",
            "code": "artifact_detection_limited",
            "message": "当前 Python 图表状态检测仅能完整解析 docx；doc 文件仅保留基础文件信息。",
        })
        return result

    with zipfile.ZipFile(path) as docx:
        names = docx.namelist()
        media_names = [name for name in names if name.startswith("word/media/") and not name.endswith("/")]
        media_name_set = set(media_names)
        chart_names = [name for name in names if name.startswith("word/charts/") and name.endswith(".xml")]
        diagram_names = [name for name in names if name.startswith("word/diagrams/") and name.endswith(".xml")]
        result["counts"]["images"] = len(media_names)
        result["counts"]["charts"] = len(chart_names)
        result["counts"]["diagrams"] = len(diagram_names)

        root = xml_root(docx, "word/document.xml")
        if root is not None:
            result["counts"]["tables"] = len(root.findall(".//w:tbl", NS))
            result["counts"]["drawings"] = len(root.findall(".//w:drawing", NS))
            result["counts"]["inline_drawings"] = len(root.findall(".//wp:inline", NS))
            result["counts"]["anchor_drawings"] = len(root.findall(".//wp:anchor", NS))
            result["counts"]["legacy_pict"] = len(root.findall(".//w:pict", NS))
            result["image_sequence"] = build_image_sequence(docx, root, media_name_set, extract_dir)
            result["counts"]["image_occurrences"] = len(result["image_sequence"])

            for text in paragraph_texts(root):
                if re.search(r"(^|\s)(fig\.?|figure)\s*\d+|图\s*\d+", text, re.I):
                    result["captions"]["figures"].append(text[:300])
                if FIGURE_CAPTION_RE.search(text):
                    result["captions"]["figure_caption_like"].append(text[:300])
                if re.search(r"(^|\s)table\s*\d+|表\s*\d+", text, re.I):
                    result["captions"]["tables"].append(text[:300])

        result["counts"]["figure_captions"] = len(result["captions"]["figures"])
        result["counts"]["figure_caption_like"] = len(result["captions"]["figure_caption_like"])
        result["counts"]["table_captions"] = len(result["captions"]["tables"])

        for name in media_names:
            data = docx.read(name)
            dims = image_dimensions(data)
            ext = os.path.splitext(name)[1].lower().lstrip(".")
            flags = []
            if len(data) < 5_000:
                flags.append("very_small_file")
            if dims["width"] is None or dims["height"] is None:
                flags.append("unknown_dimensions")
            elif dims["width"] < 300 or dims["height"] < 300:
                flags.append("low_pixel_dimensions")
            result["images"].append({
                "path": name,
                "format": ext,
                "size_bytes": len(data),
                **dims,
                "quality_flags": flags,
            })

    add_sequence_quality_flags(result)

    if result["counts"]["images"] == 0 and result["counts"]["figure_captions"] > 0:
        result["quality_flags"].append({
            "level": "P1",
            "code": "figure_caption_without_extracted_image",
            "message": "检测到 Figure/图题线索，但未提取到 word/media 图片。",
        })
    if result["counts"]["images"] == 0 and result["counts"]["drawings"] == 0 and result["counts"]["charts"] == 0:
        result["quality_flags"].append({
            "level": "P2",
            "code": "no_visual_artifacts_detected",
            "message": "未检测到图片、drawing 或 chart 对象；不得直接判定“图片无问题”。",
        })
    for image in result["images"]:
        if image["quality_flags"]:
            result["quality_flags"].append({
                "level": "P2",
                "code": "potential_low_quality_image",
                "message": f"{image['path']} 存在潜在低质量线索：{', '.join(image['quality_flags'])}",
            })

    return result


def main():
    parser = argparse.ArgumentParser(description="Analyze Word artifact state for SCI pre-review.")
    parser.add_argument("path", help="Path to .doc or .docx manuscript")
    parser.add_argument("--extract-dir", help="Directory for extracted image occurrences")
    args = parser.parse_args()
    path = args.path
    try:
        print(json.dumps(analyze_docx(path, args.extract_dir), ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({
            "schema_version": "artifact_manifest.v1",
            "file_path": os.path.abspath(path),
            "file_name": os.path.basename(path),
            "file_type": os.path.splitext(path)[1].lower().lstrip("."),
            "file_size_bytes": os.path.getsize(path) if os.path.exists(path) else None,
            "extraction_status": "failed",
            "error": str(exc),
            "counts": {},
            "images": [],
            "image_sequence": [],
            "extracted_images_dir": os.path.abspath(args.extract_dir) if args.extract_dir else None,
            "captions": {"figures": [], "figure_caption_like": [], "tables": []},
            "quality_flags": [{"level": "P1", "code": "artifact_detection_failed", "message": str(exc)}],
        }, ensure_ascii=False, indent=2))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
