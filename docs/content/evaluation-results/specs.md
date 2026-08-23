The results contain some cloud model (Openrouter, Mistral, etc) evaluation results for reference. For the local models, the test machines have the following specs. Each machine is identified by the model reference prefix used in the results table (e.g. `lmstudio-jdcmedia/ornith-1.0-35b`).

### Machine 1

| Spec | Value |
| --- | --- |
| Model reference | `lmstudio-jdcmedia` |
| CPU | Intel Core i7-4770 |
| RAM | 16 GB DDR3 |
| GPU | AMD Radeon RX 9060 XT (16GB) |
| Backend | ROCm |
| OS | Windows 10 |
| Harness | pi running in WSL |
| API Server | LM Studio |

### Machine 2

| Spec | Value |
| --- | --- |
| Model reference | `lmstudio-jdc-ws` |
| CPU | Xeon W-2235 |
| RAM | 128 GB DDR4 (quad-channel) |
| GPU | AMD Radeon RX 9060 XT (16GB) + Nvidia RTX 3060 TI (8GB) |
| Backend | Vulkan |
| OS | Windows 11 Pro |
| Harness | pi running in WSL |
| API Server | LM Studio |

If you wish to run the evaluation yourself to compare results, simply clone [the repo](https://github.com/forzabarca88/coding-agent-resources) and run the following after updating your pi "models.json" file:

```bash
cd agent-evaluation; ./run-eval.sh --model <pi provider name>/<pi model name>
```