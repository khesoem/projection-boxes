// Geometric shapes for variables
export const VARIABLE_SHAPES = ['●', '■', '▲', '◆', '★', '♦', '♠', '♣', '◉', '◐', '◑', '◒', '◓', '◔', '◕', '◖', '◗', '◘', '◙', '◚', '◛', '◜', '◝', '◞', '◟', '◠', '◡', '◢', '◣', '◤', '◥', '◦', '◧', '◨', '◩'];

// --- Sample Python program (inspired by the paper) ---
export const SAMPLE = `def f():
    a = [0, 2, 8, 1]
    s, n = 0, 0
    for x in a:
        s = s + x
        n = n + 1
    avg = s / n
    return avg

print(f())`;

// Python keywords and common builtins to ignore
export const PYTHON_KEYWORDS = new Set([
  "False","None","True","and","as","assert","async","await","break","class","continue","def","del","elif","else","except","finally","for","from","global","if","import","in","is","lambda","nonlocal","not","or","pass","raise","return","try","while","with","yield"
]);
