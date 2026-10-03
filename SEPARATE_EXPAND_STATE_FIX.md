# Separate Expand State for Simplified and Detailed Modes

## Issue
When a user expanded a supplement card in **Simplified Mode** and then switched to **Detailed Mode**, the detailed card would also be shown as expanded. The same issue occurred vice versa. This was confusing because:

1. Simplified mode shows: **Food Sources only**
2. Detailed mode shows: **Evidence, Food Sources, and Side Effects**

Users expected each mode to maintain its own independent expand/collapse state.

## Solution
Created **separate state tracking** for each mode:

### Before
```javascript
const [expandedCards, setExpandedCards] = useState(new Set());
```

### After
```javascript
const [expandedCardsSimplified, setExpandedCardsSimplified] = useState(new Set());
const [expandedCardsDetailed, setExpandedCardsDetailed] = useState(new Set());

// Use the appropriate expanded cards set based on current mode
const expandedCards = detailMode === 'simplified' ? expandedCardsSimplified : expandedCardsDetailed;
const setExpandedCards = detailMode === 'simplified' ? setExpandedCardsSimplified : setExpandedCardsDetailed;
```

## How It Works

1. **Two separate Sets** track expanded cards:
   - `expandedCardsSimplified` - tracks expanded state in simplified mode
   - `expandedCardsDetailed` - tracks expanded state in detailed mode

2. **Dynamic selection** based on current mode:
   - When `detailMode === 'simplified'`, use `expandedCardsSimplified`
   - When `detailMode === 'detailed'`, use `expandedCardsDetailed`

3. **Independent states** maintained:
   - Expanding cards in simplified mode doesn't affect detailed mode
   - Expanding cards in detailed mode doesn't affect simplified mode
   - Each mode "remembers" its own expanded state when you switch back

## User Experience

### Scenario 1: Simplified → Detailed
1. User clicks "▼ See Food Sources" in simplified mode → Card expands
2. User switches to "Detailed" mode → Card is collapsed (fresh state)
3. User switches back to "Simplified" → Card is still expanded (remembered)

### Scenario 2: Detailed → Simplified
1. User clicks "▼ More details" in detailed mode → Card expands
2. User switches to "Simplified" mode → Card is collapsed (fresh state)
3. User switches back to "Detailed" → Card is still expanded (remembered)

## Benefits

✅ **Intuitive behavior** - Each mode maintains its own state  
✅ **User control** - Switching modes doesn't reset your progress  
✅ **Mode independence** - Simplified and detailed states don't interfere  
✅ **State persistence** - Your expand choices are remembered per mode  

## Technical Details

- **No breaking changes** - All existing functionality preserved
- **Backward compatible** - Uses same `handleToggleCard()` logic
- **Performance** - Minimal memory overhead (two Sets instead of one)
- **Clean implementation** - Simple conditional selection of state

## Files Modified
- `ResultsPage.jsx` - Added separate state tracking and dynamic state selection
