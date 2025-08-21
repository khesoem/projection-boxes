# Projection Boxes - Web Prototype

A React-based web application for visualizing Python code execution with variable tracking and data-flow analysis. This project demonstrates the concept of "projection boxes" - a novel way to visualize program state during execution.

## Features

- **Real-time Python Execution**: Run Python code directly in the browser using Pyodide
- **Variable Tracking**: See how variables change line-by-line during execution
- **Multiple View Modes**:
  - **Full View**: Shows all variables and their values
  - **Scoped View**: Only shows variables referenced on each specific line
  - **Data-flow View**: Visualizes variable dependencies with geometric shapes
- **Interactive Controls**: Filter variables, change orientation, and customize the display
- **Keyboard Shortcuts**: Press 1, 2, 3 for quick view switching

## Technology Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Styling**: Tailwind CSS
- **Animations**: Framer Motion
- **Icons**: Lucide React
- **Python Runtime**: Pyodide (Python in the browser)

## Getting Started

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start development server**:
   ```bash
   npm run dev
   ```

3. **Open your browser** and navigate to `http://localhost:5173`

## Usage

1. **Write Python Code**: Use the editor on the left to write your Python code
2. **Run Code**: Click the "Run" button to execute your code
3. **Explore Variables**: Hover over code lines to see variable values in projection boxes
4. **Switch Views**: Use the view controls to explore different visualization modes
5. **Filter Variables**: Use the filter input to show/hide specific variables

## Project Structure

```
src/
├── components/          # React components
│   ├── ProjectionBox.tsx    # Main visualization component
│   ├── StatusDot.tsx        # Status indicator
│   └── ui.tsx              # Reusable UI components
├── hooks/               # Custom React hooks
│   └── useCaretLine.ts     # Cursor position tracking
├── utils/               # Utility functions
│   ├── python.ts           # Python execution utilities
│   └── dataFlow.ts         # Data-flow analysis
├── types.ts             # TypeScript type definitions
├── constants.ts         # Application constants
├── App.tsx              # Main application component
└── main.tsx             # Application entry point
```

## Development

- **Build**: `npm run build`
- **Lint**: `npm run lint`
- **Preview**: `npm run preview`

## Research Context

This project is inspired by research on program visualization and debugging tools. The "projection boxes" concept aims to make program state more visible and understandable during execution, particularly useful for educational and debugging purposes.

## License

This project is for research and educational purposes.
