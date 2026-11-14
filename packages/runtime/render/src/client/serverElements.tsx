import React, { createContext, type ReactNode } from 'react';

type Elements = Promise<ReactNode[]>;

export const ElementsContext = createContext<Elements | null>(null);

// For users to pass an element, not a Component.
export const ServerElementsProvider = ({
  elements,
  children,
}: {
  elements: Elements;
  children: ReactNode;
}) => {
  return (
    <>
      <ElementsContext.Provider value={elements}>
        {children}
      </ElementsContext.Provider>
    </>
  );
};

export const RSCServerSlot = () => {
  const elements = React.use(ElementsContext);
  return elements;
};
