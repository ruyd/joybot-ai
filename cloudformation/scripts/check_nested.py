"""Checks that the root template passes exactly the parameters each nested stack expects:
no unknown parameters, and every parameter without a default is provided.
cfn-lint does not cross-check nested stacks. Run with the Python that has cfn-lint installed:
    python cloudformation/scripts/check_nested.py
"""
import pathlib
import re
import sys

from cfnlint.decode import decode

root = pathlib.Path(__file__).resolve().parents[1]
main, errors = decode(str(root / "main.yaml"))
if errors:
    sys.exit(f"cannot parse main.yaml: {errors}")

problems = []
for name, res in main["Resources"].items():
    if res.get("Type") != "AWS::CloudFormation::Stack":
        continue
    url = str(res["Properties"]["TemplateURL"])
    match = re.search(r"stacks/([\w-]+\.yaml)", url)
    if not match:
        problems.append(f"{name}: cannot find the child template in {url}")
        continue
    child, errors = decode(str(root / "stacks" / match.group(1)))
    if errors:
        problems.append(f"{name}: cannot parse {match.group(1)}")
        continue
    expected = child.get("Parameters", {})
    passed = res["Properties"].get("Parameters", {})
    for key in passed:
        if key not in expected:
            problems.append(f"{name}: passes unknown parameter {key} to {match.group(1)}")
    for key, spec in expected.items():
        if "Default" not in spec and key not in passed:
            problems.append(f"{name}: missing required parameter {key} for {match.group(1)}")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print("nested stack parameters OK")
